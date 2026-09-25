import { loadRecentCandles, mergeCandles, saveCandles, type PrismaClient } from '@signals/db';
import type { MarketDataProvider } from '@signals/market-data';
import { completedCandles } from '@signals/signal-engine';
import {
  latestClosedCandleOpenTime,
  timeframeToMs,
  type NormalizedCandle,
  type Timeframe,
} from '@signals/types';

/** Candles re-requested beyond the gap, so vendor corrections to recent bars are picked up. */
const OVERLAP = 3;

export interface CandleWindow {
  /** Completed candles only, ascending, at most `lookback`. */
  candles: NormalizedCandle[];
  /** Open time of the latest candle that should be closed by now. */
  expectedLatest: number;
  /** True when `candles` includes the expected latest closed candle. */
  complete: boolean;
  fetched: boolean;
  fetchedCount: number;
}

/**
 * Completed candles for one (symbol, timeframe): stored history first, then only the missing
 * tail from the vendor. Newly fetched completed candles are persisted for the next cycle and
 * for the API, so identical history is never re-downloaded per user or per cycle.
 */
export async function loadCandleWindow(
  deps: { prisma: PrismaClient; marketData: MarketDataProvider },
  symbol: string,
  timeframe: Timeframe,
  opts: { now: number; lookback: number; graceMs: number; persist: boolean },
): Promise<CandleWindow> {
  const expectedLatest = latestClosedCandleOpenTime(opts.now, timeframe, opts.graceMs);
  const stored = opts.persist
    ? await loadRecentCandles(deps.prisma, symbol, timeframe, opts.lookback, deps.marketData.name)
    : [];
  const lastStored = stored.at(-1)?.time;

  if (lastStored !== undefined && lastStored >= expectedLatest && stored.length >= opts.lookback) {
    return { candles: stored, expectedLatest, complete: true, fetched: false, fetchedCount: 0 };
  }

  const tf = timeframeToMs(timeframe);
  const haveFullHistory = lastStored !== undefined && stored.length >= opts.lookback;
  // +1: the vendor's newest candle is usually still in progress and gets dropped below, so a
  // plain `lookback` request would store lookback-1 candles and never reach "full history".
  const limit = haveFullHistory
    ? Math.min(opts.lookback, Math.max(1, Math.ceil((expectedLatest - lastStored) / tf)) + OVERLAP)
    : opts.lookback + 1;

  const raw = await deps.marketData.getHistoricalCandles(symbol, timeframe, limit);
  // Strict completion: the in-progress candle (and one still inside the grace window) is dropped.
  const fresh = completedCandles(raw, timeframe, opts.now, opts.graceMs);
  if (opts.persist && fresh.length > 0) {
    await saveCandles(deps.prisma, symbol, timeframe, fresh, deps.marketData.name);
  }
  const candles = mergeCandles(stored, fresh, opts.lookback);
  return {
    candles,
    expectedLatest,
    complete: (candles.at(-1)?.time ?? -Infinity) >= expectedLatest,
    fetched: true,
    fetchedCount: raw.length,
  };
}
