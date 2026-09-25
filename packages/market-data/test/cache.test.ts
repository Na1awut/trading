import { describe, expect, it } from 'vitest';
import {
  CachedMarketDataProvider,
  InMemoryMarketDataCache,
  ScriptedMarketDataProvider,
  assessCandleFreshness,
  assessQuoteFreshness,
} from '../src';
import type { Quote } from '@signals/types';

const T0 = Date.UTC(2026, 8, 25, 14, 37, 30);

describe('InMemoryMarketDataCache', () => {
  it('expires entries after their TTL', async () => {
    let now = 0;
    const c = new InMemoryMarketDataCache(10, () => now);
    await c.set('a', 1, 1000);
    expect(await c.get('a')).toBe(1);
    now = 1001;
    expect(await c.get('a')).toBeUndefined();
  });

  it('evicts the least recently used entry when full', async () => {
    const c = new InMemoryMarketDataCache(2);
    await c.set('a', 1, 10_000);
    await c.set('b', 2, 10_000);
    await c.get('a'); // a is now most recent
    await c.set('c', 3, 10_000);
    expect(await c.get('b')).toBeUndefined();
    expect(await c.get('a')).toBe(1);
    expect(c.stats().size).toBe(2);
  });
});

describe('CachedMarketDataProvider', () => {
  function setup(now: { t: number }) {
    const inner = new ScriptedMarketDataProvider(() => now.t, 'vendorx');
    inner.setCandles('NVDA', '5m', [
      { time: T0 - 600_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    ]);
    const cached = new CachedMarketDataProvider(inner, {
      now: () => now.t,
      candleCloseGraceMs: 5_000,
      quoteTtlMs: 10_000,
    });
    return { inner, cached };
  }

  it('shares one candle download across users until the next candle closes', async () => {
    const now = { t: T0 };
    const { inner, cached } = setup(now);
    for (let i = 0; i < 5; i++) await cached.getHistoricalCandles('NVDA', '5m', 250);
    expect(inner.callsFor('getHistoricalCandles')).toHaveLength(1);
    // 14:37:30 -> next 5m close 14:40:00 + 5 s grace
    expect(cached.candleTtl('5m')).toBe(Date.UTC(2026, 8, 25, 14, 40, 5) - T0);
    now.t = Date.UTC(2026, 8, 25, 14, 40, 6);
    await cached.getHistoricalCandles('NVDA', '5m', 250);
    expect(inner.callsFor('getHistoricalCandles')).toHaveLength(2);
  });

  it('caches quotes for the configured TTL', async () => {
    const now = { t: T0 };
    const { inner, cached } = setup(now);
    await cached.getQuote('NVDA');
    now.t += 9_000;
    await cached.getQuote('NVDA');
    expect(inner.callsFor('getQuote')).toHaveLength(1);
    now.t += 2_000;
    await cached.getQuote('NVDA');
    expect(inner.callsFor('getQuote')).toHaveLength(2);
  });

  it('coalesces concurrent identical misses into one request (single-flight)', async () => {
    const { inner, cached } = setup({ t: T0 });
    await Promise.all(
      Array.from({ length: 10 }, () => cached.getHistoricalCandles('NVDA', '5m', 250)),
    );
    expect(inner.callsFor('getHistoricalCandles')).toHaveLength(1);
  });

  it('does not cache failures', async () => {
    const { inner, cached } = setup({ t: T0 });
    await expect(cached.getQuote('NOPE')).rejects.toThrow();
    await expect(cached.getQuote('NOPE')).rejects.toThrow();
    expect(inner.callsFor('getQuote', 'NOPE')).toHaveLength(2);
  });

  it('bounds candle TTL for long timeframes', () => {
    const { cached } = setup({ t: T0 });
    expect(cached.candleTtl('1d')).toBe(15 * 60_000);
  });
});

describe('freshness', () => {
  const quote = (ageMs: number, marketOpen: boolean | null): Quote => ({
    symbol: 'NVDA',
    price: 1,
    previousClose: 1,
    change: 0,
    changePercent: 0,
    volume: 0,
    timestamp: new Date(T0 - ageMs).toISOString(),
    currency: 'USD',
    exchange: 'NASDAQ',
    marketOpen,
    delayed: false,
    source: 'x',
  });

  it('flags old quotes as stale only while the market is open or unknown', () => {
    expect(assessQuoteFreshness(quote(60_000, true), T0, 900_000).stale).toBe(false);
    expect(assessQuoteFreshness(quote(3_600_000, true), T0, 900_000)).toMatchObject({
      stale: true,
      ageSeconds: 3600,
    });
    expect(assessQuoteFreshness(quote(3_600_000, null), T0, 900_000).stale).toBe(true);
    expect(assessQuoteFreshness(quote(3 * 86_400_000, false), T0, 900_000).stale).toBe(false);
  });

  it('counts missing closed candles', () => {
    // latest closed 5m candle at 14:37:30 is 14:30
    const upToDate = assessCandleFreshness([{ time: Date.UTC(2026, 8, 25, 14, 30) }], '5m', T0);
    expect(upToDate).toMatchObject({ stale: false, missingCandles: 0 });
    const behind = assessCandleFreshness([{ time: Date.UTC(2026, 8, 25, 14, 0) }], '5m', T0);
    expect(behind).toMatchObject({ stale: true, missingCandles: 6 });
    expect(
      assessCandleFreshness([{ time: Date.UTC(2026, 8, 25, 14, 0) }], '5m', T0, {
        marketOpen: false,
      }).stale,
    ).toBe(false);
  });
});
