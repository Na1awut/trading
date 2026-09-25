import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MarketDataError, ScriptedMarketDataProvider } from '@signals/market-data';
import { NOW, auth, makeApp, prisma, resetDatabase } from './helpers';

afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));

const candles = Array.from({ length: 80 }, (_, i) => ({
  time: Date.UTC(2026, 8, 25, 14, 30) - (79 - i) * 300_000,
  open: 100 + i * 0.1,
  high: 100.5 + i * 0.1,
  low: 99.5 + i * 0.1,
  close: 100.2 + i * 0.1,
  volume: 1_000_000,
}));

async function appWith(configure: (p: ScriptedMarketDataProvider) => void) {
  const provider = new ScriptedMarketDataProvider(() => NOW).setCandles('NVDA', '5m', candles);
  configure(provider);
  const { app } = await makeApp({}, { marketData: provider });
  await app.inject({
    method: 'POST',
    url: '/watchlist',
    headers: auth(),
    payload: { symbol: 'NVDA' },
  });
  return { app, provider };
}

describe('stale market data in API responses', () => {
  it('marks fresh quotes as not stale', async () => {
    const { app } = await appWith(() => {});
    const res = await app.inject({ method: 'GET', url: '/watchlist', headers: auth() });
    expect(res.json().items[0]).toMatchObject({
      quote: { symbol: 'NVDA', currency: 'USD', exchange: 'NASDAQ', marketOpen: true },
      dataStatus: { stale: false, ageSeconds: 0 },
      quoteError: null,
    });
    await app.close();
  });

  it('flags quotes that stopped updating while the market is open', async () => {
    const { app } = await appWith((p) =>
      p.setQuote('NVDA', {
        timestamp: new Date(NOW - 2 * 3_600_000).toISOString(),
        marketOpen: true,
      }),
    );
    const item = (await app.inject({ method: 'GET', url: '/watchlist', headers: auth() })).json()
      .items[0];
    expect(item.dataStatus).toMatchObject({ stale: true, ageSeconds: 7200, marketOpen: true });
    expect(item.dataStatus.reason).toMatch(/120 min ago/);
    await app.close();
  });

  it('does not flag old quotes when the market is closed', async () => {
    const { app } = await appWith((p) =>
      p.setQuote('NVDA', {
        timestamp: new Date(NOW - 2 * 86_400_000).toISOString(),
        marketOpen: false,
      }),
    );
    const item = (await app.inject({ method: 'GET', url: '/watchlist', headers: auth() })).json()
      .items[0];
    expect(item.dataStatus).toMatchObject({ stale: false, marketOpen: false });
    await app.close();
  });

  it('reports candle staleness on the asset detail', async () => {
    const lagging = candles.slice(0, -10); // last candle 50 minutes behind
    const provider = new ScriptedMarketDataProvider(() => NOW).setCandles('NVDA', '5m', lagging);
    const { app } = await makeApp({}, { marketData: provider });
    const body = (
      await app.inject({ method: 'GET', url: '/assets/NVDA?timeframe=5m', headers: auth() })
    ).json();
    expect(body.dataStatus.quote.stale).toBe(false);
    expect(body.dataStatus.candles).toMatchObject({ stale: true, reason: '10 5m candles behind' });
    await app.close();
  });

  it('keeps the watchlist usable when the vendor fails for one symbol', async () => {
    const { app, provider } = await appWith(() => {});
    provider.getQuote = async () => {
      throw new MarketDataError('RATE_LIMITED', 'credits exhausted', { vendor: 'x' });
    };
    const res = await app.inject({ method: 'GET', url: '/watchlist', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({
      symbol: 'NVDA',
      quote: null,
      dataStatus: null,
      quoteError: 'Price temporarily unavailable (rate limited)',
    });
    await app.close();
  });

  it('never evaluates indicators on the in-progress candle', async () => {
    // 14:35 candle is still open at 14:37:30, even though the vendor returns it.
    const withOpen = [
      ...candles,
      { ...candles.at(-1)!, time: Date.UTC(2026, 8, 25, 14, 35), close: 999 },
    ];
    const provider = new ScriptedMarketDataProvider(() => NOW).setCandles('NVDA', '5m', withOpen);
    const { app } = await makeApp({}, { marketData: provider });
    const body = (
      await app.inject({ method: 'GET', url: '/assets/NVDA?timeframe=5m', headers: auth() })
    ).json();
    expect(body.indicatorsAsOf).toBe('2026-09-25T14:30:00.000Z');
    expect(body.indicators.close).toBe(candles.at(-1)!.close);
    await app.close();
  });
});
