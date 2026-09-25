import { describe, expect, it } from 'vitest';
import { completedCandles, ema } from '@signals/signal-engine';
import { CachedMarketDataProvider, MockMarketDataProvider, UnknownSymbolError } from '../src';

const NOW = Date.UTC(2026, 8, 25, 14, 37, 30);

describe('MockMarketDataProvider', () => {
  const provider = new MockMarketDataProvider({ now: () => NOW });

  it('searches by symbol and name, exact matches first', async () => {
    const res = await provider.searchAssets('nv');
    expect(res[0]?.symbol).toBe('NVDA');
    expect((await provider.searchAssets('apple'))[0]?.symbol).toBe('AAPL');
    expect(await provider.searchAssets('zzzz')).toEqual([]);
  });

  it('returns ascending, gap-free candles with a trailing in-progress candle', async () => {
    const candles = await provider.getHistoricalCandles('NVDA', '5m', 100);
    expect(candles).toHaveLength(100);
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i]!.time - candles[i - 1]!.time).toBe(300_000);
    }
    const done = completedCandles(candles, '5m', NOW);
    expect(done).toHaveLength(99);
    for (const c of candles) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.volume).toBeGreaterThan(0);
    }
  });

  it('is deterministic across instances (API and worker see the same data)', async () => {
    const other = new MockMarketDataProvider({ now: () => NOW });
    expect(await other.getHistoricalCandles('AAPL', '1h', 50)).toEqual(
      await provider.getHistoricalCandles('AAPL', '1h', 50),
    );
  });

  it('keeps timeframes consistent (1h close == last 1m close of the hour)', async () => {
    const hourly = await provider.getHistoricalCandles('AAPL', '1h', 3);
    const minutes = await provider.getHistoricalCandles('AAPL', '1m', 180);
    const lastFullHour = hourly[1]!;
    const lastMinute = minutes.find((m) => m.time === lastFullHour.time + 59 * 60_000)!;
    expect(lastFullHour.close).toBeCloseTo(lastMinute.close, 3);
  });

  it('produces EMA 9/21 crossovers on 1m data within a few hours', async () => {
    const candles = await provider.getHistoricalCandles('NVDA', '1m', 300);
    const closes = candles.map((c) => c.close);
    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);
    let crosses = 0;
    for (let i = 22; i < closes.length; i++) {
      if ((e9[i - 1]! <= e21[i - 1]!) !== (e9[i]! <= e21[i]!)) crosses++;
    }
    expect(crosses).toBeGreaterThanOrEqual(4);
  });

  it('quotes include daily change', async () => {
    const q = await provider.getQuote('NVDA');
    expect(q.price).toBeGreaterThan(100);
    expect(q.changePercent).toBeCloseTo((q.change / q.previousClose) * 100, 2);
    expect(q.source).toBe('mock');
  });

  it('throws for unknown symbols', async () => {
    await expect(provider.getQuote('NOPE')).rejects.toBeInstanceOf(UnknownSymbolError);
  });
});

describe('CachedMarketDataProvider', () => {
  it('serves repeated requests from cache until the TTL expires', async () => {
    let t = NOW;
    const inner = new MockMarketDataProvider({ now: () => t });
    let calls = 0;
    const counting = Object.assign(Object.create(inner), {
      getQuote: (s: string) => {
        calls++;
        return inner.getQuote(s);
      },
    });
    const cached = new CachedMarketDataProvider(counting, 5_000, 100, () => t);
    await cached.getQuote('NVDA');
    await cached.getQuote('NVDA');
    expect(calls).toBe(1);
    t += 6_000;
    await cached.getQuote('NVDA');
    expect(calls).toBe(2);
  });

  it('does not cache failures', async () => {
    const cached = new CachedMarketDataProvider(new MockMarketDataProvider({ now: () => NOW }));
    await expect(cached.getQuote('NOPE')).rejects.toBeInstanceOf(UnknownSymbolError);
    await expect(cached.getQuote('NOPE')).rejects.toBeInstanceOf(UnknownSymbolError);
  });
});
