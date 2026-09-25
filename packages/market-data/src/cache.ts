/**
 * Cache abstraction for market data. Async and JSON-value based so a Redis (or other
 * shared) implementation can replace the in-memory one without touching callers:
 *
 *   class RedisMarketDataCache implements MarketDataCache {
 *     get = async (k) => JSON.parse(await redis.get(k) ?? 'null') ?? undefined;
 *     set = async (k, v, ttlMs) => { await redis.set(k, JSON.stringify(v), 'PX', ttlMs); };
 *     delete = async (k) => { await redis.del(k); };
 *   }
 */
export interface MarketDataCache {
  get<T>(key: string): Promise<T | undefined>;
  /** Values must be JSON-serialisable. */
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

/** Process-local LRU with per-entry TTL. Default for local development and single instances. */
export class InMemoryMarketDataCache implements MarketDataCache {
  private readonly map = new Map<string, { expires: number; value: unknown }>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly maxEntries = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.map.get(key);
    if (!entry || entry.expires <= this.now()) {
      if (entry) this.map.delete(key);
      this.misses++;
      return undefined;
    }
    // LRU: re-insert moves the key to the most-recent position.
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    this.map.delete(key);
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.map.set(key, { expires: this.now() + ttlMs, value });
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, size: this.map.size };
  }
}
