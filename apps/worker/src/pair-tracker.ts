/**
 * Remembers, per (symbol, timeframe), whether the vendor already delivered the expected
 * closed candle. Avoids hammering the vendor when data is late or the market is closed:
 * after an incomplete fetch the pair backs off exponentially until the next candle boundary.
 * Process-local on purpose - losing it only costs one extra fetch.
 */
export class PairFetchTracker {
  private readonly pairs = new Map<
    string,
    { expectedLatest: number; misses: number; nextAttemptAt: number }
  >();

  constructor(
    private readonly baseBackoffMs: number,
    private readonly maxBackoffMs = 15 * 60_000,
  ) {}

  /** Should we call the vendor for this pair now? */
  shouldFetch(key: string, expectedLatest: number, now: number): boolean {
    const p = this.pairs.get(key);
    if (!p) return true;
    if (p.expectedLatest !== expectedLatest) return true; // a new candle should have closed
    return now >= p.nextAttemptAt;
  }

  record(key: string, expectedLatest: number, complete: boolean, now: number): void {
    if (complete) {
      this.pairs.delete(key);
      return;
    }
    const prev = this.pairs.get(key);
    const misses = prev && prev.expectedLatest === expectedLatest ? prev.misses + 1 : 1;
    const backoff = Math.min(this.baseBackoffMs * 2 ** (misses - 1), this.maxBackoffMs);
    this.pairs.set(key, { expectedLatest, misses, nextAttemptAt: now + backoff });
  }
}
