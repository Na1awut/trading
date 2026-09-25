import type { AssetInfo, Candle, Quote, Timeframe } from '@signals/types';
import type { MarketDataProvider } from './provider';

interface Entry<T> {
  expires: number;
  value: Promise<T>;
}

/**
 * TTL cache decorator. Protects vendor rate limits when many app users open the same
 * asset screen; concurrent identical requests share one in-flight promise.
 */
export class CachedMarketDataProvider implements MarketDataProvider {
  private readonly cache = new Map<string, Entry<unknown>>();

  constructor(
    private readonly inner: MarketDataProvider,
    private readonly ttlMs = 10_000,
    private readonly maxEntries = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  get name() {
    return this.inner.name;
  }
  get delayed() {
    return this.inner.delayed;
  }
  get supportedTimeframes() {
    return this.inner.supportedTimeframes;
  }

  searchAssets(query: string, limit?: number): Promise<AssetInfo[]> {
    return this.memo(`search:${query}:${limit}`, 60_000, () =>
      this.inner.searchAssets(query, limit),
    );
  }

  getAsset(symbol: string): Promise<AssetInfo | null> {
    return this.memo(`asset:${symbol}`, 3_600_000, () => this.inner.getAsset(symbol));
  }

  getQuote(symbol: string): Promise<Quote> {
    return this.memo(`quote:${symbol}`, this.ttlMs, () => this.inner.getQuote(symbol));
  }

  getHistoricalCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    return this.memo(`candles:${symbol}:${timeframe}:${limit}`, this.ttlMs, () =>
      this.inner.getHistoricalCandles(symbol, timeframe, limit),
    );
  }

  private memo<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const t = this.now();
    const hit = this.cache.get(key) as Entry<T> | undefined;
    if (hit && hit.expires > t) return hit.value;
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const value = load();
    this.cache.set(key, { expires: t + ttl, value });
    // Never cache failures.
    value.catch(() => this.cache.delete(key));
    return value;
  }
}
