import { listSignalEvents, loadRecentCandles } from '@signals/db';
import { completedCandles, computeIndicatorSnapshot } from '@signals/signal-engine';
import {
  latestClosedCandleOpenTime,
  type AssetDetail,
  type NormalizedCandle,
  type Timeframe,
} from '@signals/types';
import {
  UnknownSymbolError,
  assessCandleFreshness,
  assessQuoteFreshness,
} from '@signals/market-data';
import type { AppDeps } from '../deps';

/**
 * Completed candles for display. Prefer the MarketCandle history the worker already
 * ingested (shared by all users and API instances); fall back to the (cached) provider when
 * the stored window is incomplete - e.g. a timeframe no signal uses yet.
 */
async function completedCandleWindow(
  deps: AppDeps,
  symbol: string,
  timeframe: Timeframe,
  now: number,
): Promise<NormalizedCandle[]> {
  const lookback = deps.config.SIGNAL_CANDLE_LOOKBACK;
  const grace = deps.config.CANDLE_CLOSE_GRACE_MS;
  const stored = await loadRecentCandles(
    deps.prisma,
    symbol,
    timeframe,
    lookback,
    deps.marketData.name,
  );
  if (
    stored.length >= lookback &&
    stored.at(-1)!.time >= latestClosedCandleOpenTime(now, timeframe, grace)
  ) {
    return stored;
  }
  const fetched = await deps.marketData.getHistoricalCandles(symbol, timeframe, lookback + 1);
  // Strict: only fully closed candles (incl. vendor grace period) feed the indicators.
  return completedCandles(fetched, timeframe, now, grace).slice(-lookback);
}

/** Assemble the asset detail view. All indicator math happens here, server-side. */
export async function getAssetDetail(
  deps: AppDeps,
  userId: string,
  symbol: string,
  timeframe: Timeframe,
): Promise<AssetDetail> {
  const now = deps.now?.() ?? Date.now();
  const asset = await deps.marketData.getAsset(symbol);
  if (!asset) throw new UnknownSymbolError(symbol);

  const [quote, completed, recentEvents, watchItem] = await Promise.all([
    deps.marketData.getQuote(symbol),
    completedCandleWindow(deps, symbol, timeframe, now),
    listSignalEvents(deps.prisma, userId, { ticker: symbol, limit: 10 }),
    deps.prisma.watchlistItem.findFirst({
      where: { symbol, watchlist: { userId } },
      select: { id: true },
    }),
  ]);
  const last = completed.at(-1);

  return {
    asset,
    quote,
    timeframe,
    indicatorsAsOf: last ? new Date(last.time).toISOString() : null,
    indicators: computeIndicatorSnapshot(completed),
    dataStatus: {
      quote: assessQuoteFreshness(quote, now, deps.config.MARKET_DATA_STALE_QUOTE_MS),
      candles: assessCandleFreshness(completed, timeframe, now, {
        graceMs: deps.config.CANDLE_CLOSE_GRACE_MS,
        marketOpen: quote.marketOpen,
      }),
    },
    inWatchlist: watchItem !== null,
    recentEvents,
  };
}
