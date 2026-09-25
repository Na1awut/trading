import type { AssetInfo, NormalizedCandle, Quote, Timeframe } from '@signals/types';
import type { MarketDataError } from '../errors';
import type { RequestMeta, VendorRequest } from '../http/vendor-http-client';

/**
 * Everything vendor-specific lives behind this interface: endpoint paths, parameter
 * names, symbol mapping, response validation and error classification. The generic
 * RealMarketDataProvider handles transport concerns (timeouts, retries, rate limits).
 * Adding a vendor = one new adapter file + registration in `vendors/index.ts`.
 */
export interface VendorAdapter {
  readonly vendor: string;
  readonly defaultBaseUrl: string;
  /** Hosts MARKET_DATA_BASE_URL may point at without MARKET_DATA_ALLOW_CUSTOM_BASE_URL. */
  readonly allowedHosts: readonly string[];
  readonly supportedTimeframes: readonly Timeframe[];
  readonly maxCandlesPerRequest: number;

  authQuery(apiKey: string): Record<string, string>;
  classifyError(status: number, body: unknown, meta: RequestMeta): MarketDataError | null;

  quoteRequest(symbol: string): VendorRequest;
  parseQuote(body: unknown, symbol: string, ctx: ParseContext): Quote;

  candlesRequest(symbol: string, timeframe: Timeframe, limit: number): VendorRequest;
  parseCandles(body: unknown, symbol: string, timeframe: Timeframe): NormalizedCandle[];

  searchRequest(query: string, limit: number): VendorRequest;
  parseSearch(body: unknown): AssetInfo[];
}

export interface ParseContext {
  delayed: boolean;
  source: string;
}
