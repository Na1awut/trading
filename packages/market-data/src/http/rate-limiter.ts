import { MarketDataError } from '../errors';

export interface RateLimiter {
  /** Resolves when a request may be sent; throws RATE_LIMITED if waiting would exceed maxWaitMs. */
  acquire(maxWaitMs?: number): Promise<void>;
}

/**
 * Client-side token bucket so we stay under the vendor's per-minute quota instead of
 * discovering it through 429s. Calls are serialised, so concurrent callers queue fairly.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();
  private readonly ratePerMs: number;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly opts: {
      vendor?: string;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      defaultMaxWaitMs?: number;
    } = {},
  ) {
    if (!(requestsPerMinute > 0)) throw new RangeError('requestsPerMinute must be > 0');
    this.tokens = requestsPerMinute;
    this.last = this.now();
    this.ratePerMs = requestsPerMinute / 60_000;
  }

  acquire(maxWaitMs = this.opts.defaultMaxWaitMs ?? 30_000): Promise<void> {
    const run = this.queue.then(() => this.take(maxWaitMs));
    // Keep the queue alive even if this caller is rejected.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async take(maxWaitMs: number): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.ratePerMs);
      if (waitMs > maxWaitMs) {
        throw new MarketDataError(
          'RATE_LIMITED',
          `Local rate limit (${this.requestsPerMinute}/min) would require waiting ${waitMs}ms`,
          { vendor: this.opts.vendor, retryAfterMs: waitMs },
        );
      }
      await (this.opts.sleep ?? defaultSleep)(waitMs);
      this.refill();
    }
    this.tokens = Math.max(0, this.tokens - 1);
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.requestsPerMinute, this.tokens + (t - this.last) * this.ratePerMs);
    this.last = t;
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
