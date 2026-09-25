import type { Candle, DataFreshness, Quote, Timeframe } from '@signals/types';
import { latestClosedCandleOpenTime, timeframeToMs } from '@signals/types';

/**
 * Quote staleness: old data is only "stale" if the market is (or may be) open. A closed
 * market legitimately shows the last close for hours/days.
 */
export function assessQuoteFreshness(
  quote: Quote,
  nowMs: number,
  staleAfterMs: number,
): DataFreshness {
  const ts = Date.parse(quote.timestamp);
  const ageSeconds = Number.isFinite(ts) ? Math.max(0, Math.round((nowMs - ts) / 1000)) : null;
  if (ageSeconds === null) {
    return { stale: true, ageSeconds, marketOpen: quote.marketOpen, reason: 'missing timestamp' };
  }
  const tooOld = ageSeconds * 1000 > staleAfterMs;
  const stale = tooOld && quote.marketOpen !== false;
  return {
    stale,
    ageSeconds,
    marketOpen: quote.marketOpen,
    reason: stale
      ? `last update ${Math.round(ageSeconds / 60)} min ago while market ${quote.marketOpen ? 'open' : 'status unknown'}`
      : null,
  };
}

/**
 * Candle staleness: how many fully-closed candles are missing after the latest one we have.
 * Only meaningful while the market is open (pass `marketOpen` from the quote if known).
 */
export function assessCandleFreshness(
  completed: ReadonlyArray<Pick<Candle, 'time'>>,
  timeframe: Timeframe,
  nowMs: number,
  opts: { graceMs?: number; toleranceCandles?: number; marketOpen?: boolean | null } = {},
): DataFreshness & { missingCandles: number | null } {
  const last = completed.at(-1);
  if (!last) {
    return {
      stale: true,
      ageSeconds: null,
      marketOpen: opts.marketOpen ?? null,
      reason: 'no completed candles',
      missingCandles: null,
    };
  }
  const expected = latestClosedCandleOpenTime(nowMs, timeframe, opts.graceMs ?? 0);
  const missingCandles = Math.max(0, Math.floor((expected - last.time) / timeframeToMs(timeframe)));
  const stale = missingCandles > (opts.toleranceCandles ?? 2) && opts.marketOpen !== false;
  return {
    stale,
    ageSeconds: Math.round((nowMs - (last.time + timeframeToMs(timeframe))) / 1000),
    marketOpen: opts.marketOpen ?? null,
    reason: stale ? `${missingCandles} ${timeframe} candles behind` : null,
    missingCandles,
  };
}
