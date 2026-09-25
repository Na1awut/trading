import { listSignalEvents } from '@signals/db';
import { completedCandles, computeIndicatorSnapshot } from '@signals/signal-engine';
import type { AssetDetail, Timeframe } from '@signals/types';
import { UnknownSymbolError } from '@signals/market-data';
import type { AppDeps } from '../deps';

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

  const [quote, candles, recentEvents, watchItem] = await Promise.all([
    deps.marketData.getQuote(symbol),
    deps.marketData.getHistoricalCandles(symbol, timeframe, deps.config.SIGNAL_CANDLE_LOOKBACK),
    listSignalEvents(deps.prisma, userId, { ticker: symbol, limit: 10 }),
    deps.prisma.watchlistItem.findFirst({ where: { symbol, watchlist: { userId } }, select: { id: true } }),
  ]);
  const completed = completedCandles(candles, timeframe, now);
  const last = completed.at(-1);

  return {
    asset,
    quote,
    timeframe,
    indicatorsAsOf: last ? new Date(last.time).toISOString() : null,
    indicators: computeIndicatorSnapshot(completed),
    inWatchlist: watchItem !== null,
    recentEvents,
  };
}
