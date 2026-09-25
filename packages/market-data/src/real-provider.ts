import type { AssetInfo, Candle, Quote, Timeframe } from '@signals/types';
import { ProviderNotConfiguredError, type MarketDataProvider } from './provider';

export interface RealProviderOptions {
  /** Vendor identifier, e.g. "polygon" | "finnhub" | "alphavantage" | "twelvedata" | "tiingo". */
  vendor: string;
  /** MARKET_DATA_API_KEY - never commit; load from the environment / secret manager. */
  apiKey?: string;
  /** MARKET_DATA_BASE_URL - vendor REST base URL. */
  baseUrl?: string;
  /** Whether the purchased plan delivers delayed data (most free tiers: 15 min). */
  delayed?: boolean;
}

/**
 * PLACEHOLDER for a licensed market-data vendor.
 *
 * To integrate a vendor:
 *  1. Implement the four methods below with the vendor's REST endpoints
 *     (symbol search, snapshot/quote, aggregates/candles).
 *  2. Map vendor symbols to our canonical symbols (e.g. SET listings use the `.BK` suffix).
 *  3. Respect the vendor's rate limits - the worker fetches candles once per
 *     (symbol, timeframe) per cycle, so calls/min ~= active pairs * (60_000 / SIGNAL_POLL_INTERVAL_MS).
 *  4. Set `delayed` truthfully; the UI surfaces it next to every price.
 *
 * Licensing: check that your plan permits storing candles and redistributing derived
 * data (alerts) to end users. Several "free" tiers are for personal, non-display use only.
 * See docs/MARKET_DATA.md.
 */
export class RealMarketDataProvider implements MarketDataProvider {
  readonly name: string;
  readonly delayed: boolean;
  readonly supportedTimeframes: ReadonlyArray<Timeframe> = ['1m', '5m', '15m', '1h', '1d'];

  constructor(private readonly options: RealProviderOptions) {
    this.name = options.vendor;
    this.delayed = options.delayed ?? true;
    if (!options.apiKey) {
      throw new ProviderNotConfiguredError(
        `MARKET_DATA_PROVIDER=real requires MARKET_DATA_API_KEY (vendor "${options.vendor}"). ` +
          'Use MARKET_DATA_PROVIDER=mock for local development.',
      );
    }
  }

  async searchAssets(_query: string, _limit?: number): Promise<AssetInfo[]> {
    throw this.notImplemented('searchAssets');
  }

  async getAsset(_symbol: string): Promise<AssetInfo | null> {
    throw this.notImplemented('getAsset');
  }

  async getQuote(_symbol: string): Promise<Quote> {
    throw this.notImplemented('getQuote');
  }

  async getHistoricalCandles(_symbol: string, _timeframe: Timeframe, _limit: number): Promise<Candle[]> {
    throw this.notImplemented('getHistoricalCandles');
  }

  private notImplemented(method: string): Error {
    return new ProviderNotConfiguredError(
      `RealMarketDataProvider(${this.options.vendor}).${method} is not implemented yet - see packages/market-data/src/real-provider.ts`,
    );
  }
}
