import type { AssetInfo, Candle, Quote, Timeframe } from '@signals/types';

/**
 * Vendor-neutral market data interface. Everything above this layer (API, worker,
 * signal engine) depends only on this contract, so swapping Polygon/Finnhub/Twelve Data/
 * a Thai SET feed/a crypto exchange means writing one new implementation.
 */
export interface MarketDataProvider {
  /** Short identifier shown in quotes/logs, e.g. "mock", "twelvedata". */
  readonly name: string;
  /** Whether quotes are delayed (e.g. 15 min on many free tiers). Surfaced in the UI. */
  readonly delayed: boolean;
  /** Timeframes this provider can serve. */
  readonly supportedTimeframes: ReadonlyArray<Timeframe>;

  searchAssets(query: string, limit?: number): Promise<AssetInfo[]>;
  getAsset(symbol: string): Promise<AssetInfo | null>;
  getQuote(symbol: string): Promise<Quote>;
  /**
   * Most recent `limit` candles, ascending by open time. The last candle MAY still be
   * in progress - callers must filter with `completedCandles()` before evaluating signals.
   */
  getHistoricalCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
}

export class UnknownSymbolError extends Error {
  constructor(readonly symbol: string) {
    super(`Unknown symbol: ${symbol}`);
    this.name = 'UnknownSymbolError';
  }
}

export class ProviderNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
  }
}
