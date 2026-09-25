import type { AssetInfo, NormalizedCandle, Quote, Timeframe } from '@signals/types';

export { MarketDataError, UnknownSymbolError, ProviderNotConfiguredError } from './errors';
export type { MarketDataErrorCode } from './errors';

/**
 * Vendor-neutral market data interface. Everything above this layer (API, worker,
 * signal engine) depends only on this contract and the normalised domain types.
 */
export interface MarketDataProvider {
  /** Short identifier shown in quotes/logs, e.g. "mock", "twelvedata". */
  readonly name: string;
  /** Whether quotes are delayed (e.g. 15 min on many plans). Surfaced in the UI. */
  readonly delayed: boolean;
  /** Timeframes this provider can serve. */
  readonly supportedTimeframes: ReadonlyArray<Timeframe>;

  searchSymbols(query: string, limit?: number): Promise<AssetInfo[]>;
  getAsset(symbol: string): Promise<AssetInfo | null>;
  getQuote(symbol: string): Promise<Quote>;
  /**
   * Most recent `limit` candles, ascending by open time (UTC). The last candle MAY still be
   * in progress - callers must filter with `completedCandles()` before evaluating signals.
   */
  getHistoricalCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<NormalizedCandle[]>;
}
