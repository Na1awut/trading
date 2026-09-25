import type { AssetInfo, NormalizedCandle, Quote, Timeframe } from '@signals/types';
import { candleOpenTime, timeframeToMs } from '@signals/types';
import { InMemoryMarketDataCache, type MarketDataCache } from './cache';
import { withDefaults } from './defaults';
import type { MarketDataProvider } from './provider';

export interface CachedProviderOptions {
  cache?: MarketDataCache;
  /** Quotes: 5-15 s is a sensible range. */
  quoteTtlMs?: number;
  searchTtlMs?: number;
  assetTtlMs?: number;
  /** Must match the worker's CANDLE_CLOSE_GRACE_MS. */
  candleCloseGraceMs?: number;
  /** Upper bound for candle TTL (e.g. to pick up vendor corrections on daily bars). */
  maxCandleTtlMs?: number;
  now?: () => number;
  /** Called for every lookup (metrics). kind = quote | candles | search | asset. */
  onCacheResult?: (kind: string, hit: boolean) => void;
}

/**
 * Caching decorator.
 * - Quotes: short fixed TTL.
 * - Candles: cached until the NEXT candle of that timeframe closes (+ grace), because
 *   completed history cannot change before then. So all users viewing NVDA 5m share one
 *   download per 5 minutes, instead of one per request.
 * - Concurrent identical misses share one in-flight request (single-flight, per process).
 */
export class CachedMarketDataProvider implements MarketDataProvider {
  private readonly cache: MarketDataCache;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly o: Required<Omit<CachedProviderOptions, 'cache' | 'onCacheResult'>>;
  private readonly onCacheResult?: (kind: string, hit: boolean) => void;

  constructor(
    private readonly inner: MarketDataProvider,
    options: CachedProviderOptions = {},
  ) {
    this.cache = options.cache ?? new InMemoryMarketDataCache(5_000, options.now);
    const { cache: _cache, onCacheResult, ...rest } = options;
    this.onCacheResult = onCacheResult;
    this.o = withDefaults(
      {
        quoteTtlMs: 10_000,
        searchTtlMs: 60_000,
        assetTtlMs: 6 * 3_600_000,
        candleCloseGraceMs: 5_000,
        maxCandleTtlMs: 15 * 60_000,
        now: Date.now,
      },
      rest,
    );
  }

  get name() {
    return this.inner.name;
  }
  get delayed() {
    return this.inner.delayed;
  }
  get supportedTimeframes() {
    return this.inner.supportedTimeframes;
  }

  searchSymbols(query: string, limit = 20): Promise<AssetInfo[]> {
    return this.memo(`search:${query.trim().toUpperCase()}:${limit}`, this.o.searchTtlMs, () =>
      this.inner.searchSymbols(query, limit),
    );
  }

  getAsset(symbol: string): Promise<AssetInfo | null> {
    return this.memo(`asset:${symbol}`, this.o.assetTtlMs, () => this.inner.getAsset(symbol));
  }

  getQuote(symbol: string): Promise<Quote> {
    return this.memo(`quote:${symbol}`, this.o.quoteTtlMs, () => this.inner.getQuote(symbol));
  }

  getHistoricalCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<NormalizedCandle[]> {
    return this.memo(`candles:${symbol}:${timeframe}:${limit}`, this.candleTtl(timeframe), () =>
      this.inner.getHistoricalCandles(symbol, timeframe, limit),
    );
  }

  /** Time until the next candle close (+ grace), clamped to [1 s, maxCandleTtlMs]. */
  candleTtl(timeframe: Timeframe): number {
    const now = this.o.now();
    const nextClose =
      candleOpenTime(now - this.o.candleCloseGraceMs, timeframe) +
      timeframeToMs(timeframe) +
      this.o.candleCloseGraceMs;
    return Math.min(Math.max(nextClose - now, 1_000), this.o.maxCandleTtlMs);
  }

  private async memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const fullKey = `md:${this.inner.name}:${key}`;
    const kind = key.slice(0, key.indexOf(':'));
    const hit = await this.cache.get<T>(fullKey);
    this.onCacheResult?.(kind, hit !== undefined);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(fullKey) as Promise<T> | undefined;
    if (pending) return pending;
    const p = load()
      .then(async (value) => {
        await this.cache.set(fullKey, value, ttlMs); // failures are never cached
        return value;
      })
      .finally(() => this.inflight.delete(fullKey));
    this.inflight.set(fullKey, p);
    return p;
  }
}
