import type { AssetInfo, NormalizedCandle, Quote, Timeframe } from '@signals/types';
import { resolveBaseUrl } from './base-url';
import { MarketDataError, ProviderNotConfiguredError, UnknownSymbolError } from './errors';
import { TokenBucketRateLimiter } from './http/rate-limiter';
import { VendorHttpClient } from './http/vendor-http-client';
import { noopLogger, type MarketDataLogger } from './logger';
import type { MarketDataProvider } from './provider';
import { SUPPORTED_VENDORS, VENDOR_ADAPTERS } from './vendors';
import type { VendorAdapter } from './vendors/types';

export interface RealProviderOptions {
  /** MARKET_DATA_VENDOR, e.g. "twelvedata". */
  vendor: string;
  /** MARKET_DATA_API_KEY - load from the environment / secret manager, never commit. */
  apiKey?: string;
  /** MARKET_DATA_BASE_URL - optional override (validated against SSRF). */
  baseUrl?: string;
  allowCustomBaseUrl?: boolean;
  /** Whether your plan delivers delayed data. Surfaced next to every price. */
  delayed?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  /** Client-side cap to stay under the plan's per-minute quota. */
  requestsPerMinute?: number;
  logger?: MarketDataLogger;
  /** Test seams. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Inject a custom adapter (tests / new vendors). */
  adapter?: VendorAdapter;
}

/**
 * Real market data behind the vendor-neutral MarketDataProvider interface.
 * Transport (timeouts, retries, rate limits, logging) is generic; the vendor adapter does
 * request building, response validation and normalisation.
 */
export class RealMarketDataProvider implements MarketDataProvider {
  readonly name: string;
  readonly delayed: boolean;
  readonly supportedTimeframes: ReadonlyArray<Timeframe>;
  private readonly adapter: VendorAdapter;
  private readonly http: VendorHttpClient;

  constructor(options: RealProviderOptions) {
    const adapter = options.adapter ?? VENDOR_ADAPTERS[options.vendor.toLowerCase()];
    if (!adapter) {
      throw new ProviderNotConfiguredError(
        `Unsupported MARKET_DATA_VENDOR "${options.vendor}". Supported: ${SUPPORTED_VENDORS.join(', ')}`,
      );
    }
    if (!options.apiKey) {
      throw new ProviderNotConfiguredError(
        `MARKET_DATA_PROVIDER=real requires MARKET_DATA_API_KEY (vendor "${adapter.vendor}"). ` +
          'Use MARKET_DATA_PROVIDER=mock for local development.',
      );
    }
    this.adapter = adapter;
    this.name = adapter.vendor;
    this.delayed = options.delayed ?? true;
    this.supportedTimeframes = adapter.supportedTimeframes;
    const baseUrl = resolveBaseUrl(options.baseUrl, adapter, {
      allowCustom: options.allowCustomBaseUrl,
    });
    const logger = options.logger ?? noopLogger;
    this.http = new VendorHttpClient({
      vendor: adapter.vendor,
      baseUrl,
      timeoutMs: options.timeoutMs ?? 8_000,
      maxRetries: options.maxRetries ?? 3,
      rateLimiter: new TokenBucketRateLimiter(options.requestsPerMinute ?? 8, {
        vendor: adapter.vendor,
        now: options.now,
        sleep: options.sleep,
      }),
      logger,
      classify: (status, body, meta) => adapter.classifyError(status, body, meta),
      authQuery: adapter.authQuery(options.apiKey),
      secrets: [options.apiKey],
      fetch: options.fetch,
      sleep: options.sleep,
      random: options.random,
      now: options.now,
    });
  }

  async getQuote(symbol: string): Promise<Quote> {
    const body = await this.http.getJson(this.adapter.quoteRequest(symbol), {
      operation: 'quote',
      symbol,
    });
    return this.adapter.parseQuote(body, symbol, { delayed: this.delayed, source: this.name });
  }

  async getHistoricalCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<NormalizedCandle[]> {
    if (!this.supportedTimeframes.includes(timeframe)) {
      throw new MarketDataError(
        'BAD_REQUEST',
        `Timeframe ${timeframe} not supported by ${this.name}`,
        {
          vendor: this.name,
          symbol,
        },
      );
    }
    const n = Math.min(limit, this.adapter.maxCandlesPerRequest);
    const body = await this.http.getJson(this.adapter.candlesRequest(symbol, timeframe, n), {
      operation: 'candles',
      symbol,
    });
    return this.adapter.parseCandles(body, symbol, timeframe).slice(-n);
  }

  async searchSymbols(query: string, limit = 20): Promise<AssetInfo[]> {
    const q = query.trim();
    if (!q) return [];
    const body = await this.http.getJson(this.adapter.searchRequest(q, limit), {
      operation: 'search',
    });
    return this.adapter.parseSearch(body).slice(0, limit);
  }

  async getAsset(symbol: string): Promise<AssetInfo | null> {
    const wanted = symbol.toUpperCase();
    try {
      const results = await this.searchSymbols(wanted.replace(/\.BK$/, '').replace('-', '/'), 50);
      return results.find((a) => a.symbol === wanted) ?? null;
    } catch (e) {
      if (e instanceof UnknownSymbolError) return null;
      throw e;
    }
  }
}
