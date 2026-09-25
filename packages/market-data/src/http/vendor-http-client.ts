import { withDefaults } from '../defaults';
import { MarketDataError } from '../errors';
import type { MarketDataLogger } from '../logger';
import { defaultSleep, type RateLimiter } from './rate-limiter';

export interface VendorRequest {
  /** Fixed endpoint path from the adapter - never built from user input. */
  path: string;
  /** Query parameters; values are URL-encoded by URLSearchParams. */
  query: Record<string, string>;
}

export interface RequestMeta {
  operation: 'quote' | 'candles' | 'search' | 'asset';
  symbol?: string;
}

/**
 * One HTTP attempt, reported to an optional observer (metrics, live validation audits).
 * Never contains the request URL/query (where the API key lives) or request headers.
 */
export interface VendorResponseObservation {
  vendor: string;
  operation: RequestMeta['operation'];
  symbol?: string;
  path: string;
  attempt: number;
  /** HTTP status, or null when no response arrived (timeout / network). */
  httpStatus: number | null;
  durationMs: number;
  ok: boolean;
  errorCode?: MarketDataError['code'];
  /** Rate-limit / credit headers only (e.g. api-credits-used, api-credits-left, retry-after). */
  rateLimitHeaders: Record<string, string>;
  /** Parsed JSON body (for audits). Callers must sanitise before persisting. */
  body?: unknown;
}

const RATE_HEADER = /credit|rate|limit|retry-after|quota/i;

interface AttemptContext {
  status: number | null;
  headers: Record<string, string>;
  body: unknown;
}

export interface VendorHttpClientOptions {
  vendor: string;
  baseUrl: string;
  timeoutMs: number;
  /** Retries AFTER the first attempt (bounded). */
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  rateLimiter?: RateLimiter;
  logger: MarketDataLogger;
  /** Maps (HTTP status, parsed body) to a normalised error, or null for success. */
  classify: (status: number, body: unknown, meta: RequestMeta) => MarketDataError | null;
  /** Extra query params added to every request (e.g. the API key). Never logged. */
  authQuery?: Record<string, string>;
  /** Strings that must never appear in logs or error messages (API keys). */
  secrets?: string[];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Called after every attempt (success or failure). Must not throw. */
  onResponse?: (o: VendorResponseObservation) => void;
}

/**
 * HTTP transport for market-data vendors: per-request timeout, bounded retries with
 * exponential backoff + jitter, Retry-After support, client-side rate limiting, error
 * normalisation and structured logs (path + status only - never query strings or keys).
 */
export class VendorHttpClient {
  private readonly o: Required<
    Omit<VendorHttpClientOptions, 'rateLimiter' | 'authQuery' | 'secrets' | 'onResponse'>
  > &
    Pick<VendorHttpClientOptions, 'rateLimiter' | 'authQuery' | 'secrets' | 'onResponse'>;

  constructor(options: VendorHttpClientOptions) {
    this.o = withDefaults(
      {
        baseDelayMs: 500,
        maxDelayMs: 10_000,
        fetch: globalThis.fetch.bind(globalThis),
        sleep: defaultSleep,
        random: Math.random,
        now: Date.now,
      },
      options,
    );
  }

  async getJson(req: VendorRequest, meta: RequestMeta): Promise<unknown> {
    const url = new URL(
      req.path.replace(/^\//, ''),
      this.o.baseUrl.endsWith('/') ? this.o.baseUrl : `${this.o.baseUrl}/`,
    );
    for (const [k, v] of Object.entries({ ...req.query, ...this.o.authQuery })) {
      url.searchParams.set(k, v);
    }
    const logBase = {
      vendor: this.o.vendor,
      operation: meta.operation,
      symbol: meta.symbol,
      path: url.pathname,
    };

    for (let attempt = 0; ; attempt++) {
      const started = this.o.now();
      const seen: AttemptContext = { status: null, headers: {}, body: undefined };
      let error: MarketDataError;
      try {
        if (this.o.rateLimiter) await this.o.rateLimiter.acquire();
        const body = await this.attempt(url, meta, seen);
        const durationMs = this.o.now() - started;
        this.o.logger.debug({ ...logBase, attempt, durationMs }, 'market data request ok');
        this.observe({
          ...logBase,
          attempt,
          httpStatus: seen.status,
          durationMs,
          ok: true,
          rateLimitHeaders: seen.headers,
          body,
        });
        return body;
      } catch (e) {
        error = e instanceof MarketDataError ? e : this.wrapUnknown(e);
      }
      this.observe({
        ...logBase,
        attempt,
        httpStatus: seen.status,
        durationMs: this.o.now() - started,
        ok: false,
        errorCode: error.code,
        rateLimitHeaders: seen.headers,
        body: seen.body,
      });

      const logObj = {
        ...logBase,
        attempt,
        code: error.code,
        httpStatus: error.httpStatus,
        durationMs: this.o.now() - started,
        error: this.redact(error.message),
      };
      if (!error.retryable || attempt >= this.o.maxRetries) {
        this.o.logger.warn(logObj, 'market data request failed');
        throw error;
      }
      const delay = this.retryDelay(attempt, error.retryAfterMs);
      this.o.logger.warn({ ...logObj, retryInMs: delay }, 'market data request failed - retrying');
      await this.o.sleep(delay);
    }
  }

  private observe(o: VendorResponseObservation) {
    try {
      this.o.onResponse?.(o);
    } catch {
      // observers must never break requests
    }
  }

  private async attempt(url: URL, meta: RequestMeta, seen: AttemptContext): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.o.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.o.fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      seen.status = res.status;
      res.headers.forEach((value, key) => {
        if (RATE_HEADER.test(key)) seen.headers[key] = value;
      });
      text = await res.text();
    } catch (e) {
      if (controller.signal.aborted) {
        throw new MarketDataError('TIMEOUT', `Request timed out after ${this.o.timeoutMs}ms`, {
          vendor: this.o.vendor,
          symbol: meta.symbol,
        });
      }
      throw new MarketDataError(
        'NETWORK',
        this.redact(`Network error: ${(e as Error).message ?? e}`),
        {
          vendor: this.o.vendor,
          symbol: meta.symbol,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    let body: unknown;
    try {
      body = text.length ? JSON.parse(text) : undefined;
    } catch {
      // A non-JSON ERROR page (proxy, WAF, CDN, load balancer) is classified by its HTTP
      // status - e.g. an HTML 403 from a firewall is FORBIDDEN, not a vendor format change.
      // A 404 without a vendor body means a wrong URL, not an unknown symbol.
      if (res.status >= 400) {
        throw res.status === 404
          ? new MarketDataError('BAD_REQUEST', 'HTTP 404 (non-JSON): check MARKET_DATA_BASE_URL', {
              vendor: this.o.vendor,
              httpStatus: 404,
              symbol: meta.symbol,
            })
          : this.statusError(res, meta);
      }
      throw new MarketDataError('BAD_RESPONSE', `Non-JSON response (HTTP ${res.status})`, {
        vendor: this.o.vendor,
        httpStatus: res.status,
        symbol: meta.symbol,
      });
    }

    seen.body = body;
    const classified = this.o.classify(res.status, body, meta);
    if (classified) {
      if (classified.code === 'RATE_LIMITED' && classified.retryAfterMs === undefined) {
        const ra = parseRetryAfter(res.headers.get('retry-after'), this.o.now());
        if (ra !== undefined) {
          throw new MarketDataError(classified.code, classified.message, {
            vendor: classified.vendor,
            httpStatus: classified.httpStatus,
            symbol: classified.symbol,
            retryAfterMs: ra,
          });
        }
      }
      throw classified;
    }
    if (!res.ok) throw this.statusError(res, meta);
    return body;
  }

  private statusError(res: Response, meta: RequestMeta): MarketDataError {
    return statusToError(
      res.status,
      `HTTP ${res.status}`,
      this.o.vendor,
      meta.symbol,
      parseRetryAfter(res.headers.get('retry-after'), this.o.now()),
    );
  }

  private retryDelay(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) return Math.min(Math.max(retryAfterMs, 0), this.o.maxDelayMs);
    const exp = this.o.baseDelayMs * 2 ** attempt;
    // "Equal jitter": half fixed, half random - avoids synchronised retry storms.
    return Math.min(Math.round(exp / 2 + (this.o.random() * exp) / 2), this.o.maxDelayMs);
  }

  private wrapUnknown(e: unknown): MarketDataError {
    return new MarketDataError('NETWORK', this.redact(String((e as Error)?.message ?? e)), {
      vendor: this.o.vendor,
    });
  }

  /** Remove any configured secret from a string before it is logged or thrown. */
  redact(text: string): string {
    let out = text;
    for (const s of this.o.secrets ?? []) if (s) out = out.split(s).join('[REDACTED]');
    return out;
  }
}

/** Map an HTTP-like status code to a normalised error. */
export function statusToError(
  status: number,
  message: string,
  vendor: string,
  symbol?: string,
  retryAfterMs?: number,
): MarketDataError {
  const opts = { vendor, httpStatus: status, symbol, retryAfterMs };
  if (status === 401) return new MarketDataError('UNAUTHORIZED', message, opts);
  if (status === 403) return new MarketDataError('FORBIDDEN', message, opts);
  if (status === 404) return new MarketDataError('INVALID_SYMBOL', message, opts);
  if (status === 429) return new MarketDataError('RATE_LIMITED', message, opts);
  if (status === 408) return new MarketDataError('TIMEOUT', message, opts);
  if (status >= 500) return new MarketDataError('UPSTREAM_UNAVAILABLE', message, opts);
  return new MarketDataError('BAD_REQUEST', message, opts);
}

export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}
