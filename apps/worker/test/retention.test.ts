import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, saveCandles, upsertAsset } from '@signals/db';
import { resetDatabase, testDatabaseUrl } from '@signals/db/testing';
import { MOCK_ASSETS } from '@signals/market-data';
import { WorkerHealth } from '../src/health';
import { runCandleRetention } from '../src/retention';

const prisma = createPrismaClient(testDatabaseUrl('worker_test'));
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 25, 12);

afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));

const candle = (time: number) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 });

describe('MarketCandle retention', () => {
  it('deletes only candles older than each timeframe policy; 0 keeps forever', async () => {
    for (const s of ['NVDA', 'AAPL'])
      await upsertAsset(
        prisma,
        MOCK_ASSETS.find((a) => a.symbol === s)!,
      );
    for (const s of ['NVDA', 'AAPL']) {
      await saveCandles(
        prisma,
        s,
        '1m',
        [candle(NOW - 10 * DAY), candle(NOW - 8 * DAY), candle(NOW - DAY)],
        'mock',
      );
      await saveCandles(
        prisma,
        s,
        '1h',
        [candle(NOW - 800 * DAY), candle(NOW - 100 * DAY)],
        'mock',
      );
      await saveCandles(prisma, s, '1d', [candle(NOW - 5000 * DAY)], 'mock');
    }
    const result = await runCandleRetention(
      prisma,
      { '1m': 7, '5m': 60, '15m': 180, '1h': 730, '1d': 0 },
      NOW,
      1,
    );
    expect(result.deleted).toEqual({ '1m': 4, '5m': 0, '15m': 0, '1h': 2 });
    const left = await prisma.marketCandle.groupBy({
      by: ['timeframe'],
      _count: true,
      orderBy: { timeframe: 'asc' },
    });
    expect(left.map((g) => [g.timeframe, g._count])).toEqual([
      ['1d', 2],
      ['1h', 2],
      ['1m', 2],
    ]);
    // idempotent
    expect(
      (await runCandleRetention(prisma, { '1m': 7, '5m': 60, '15m': 180, '1h': 730, '1d': 0 }, NOW))
        .deleted['1m'],
    ).toBe(0);
  });
});

describe('worker health', () => {
  it('is healthy while cycles succeed and unhealthy after prolonged failure', () => {
    let t = 0;
    const h = new WorkerHealth(60_000, () => t);
    expect(h.snapshot().status).toBe('ok'); // start-up grace
    t = 30_000;
    h.recordSuccess();
    t = 80_000;
    h.recordFailure();
    expect(h.snapshot()).toMatchObject({ status: 'ok', consecutiveFailures: 1 });
    t = 100_000;
    h.recordFailure();
    expect(h.snapshot()).toMatchObject({ status: 'unhealthy', consecutiveFailures: 2 });
  });
});
