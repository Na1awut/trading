import { Prisma } from '@prisma/client';
import type { Candle, NormalizedCandle, Timeframe } from '@signals/types';
import type { Db } from '../client';

/**
 * MarketCandle store: completed candles ingested by the worker and reused by the API, so a
 * (symbol, timeframe) series is downloaded from the vendor once and shared by every user.
 * Rows carry `source` (provider name) so history from different providers is never mixed.
 */
export async function loadRecentCandles(
  db: Db,
  symbol: string,
  timeframe: Timeframe,
  limit: number,
  source: string,
): Promise<NormalizedCandle[]> {
  const rows = await db.marketCandle.findMany({
    where: { symbol, timeframe, source },
    orderBy: { time: 'desc' },
    take: limit,
  });
  return rows.reverse().map((r) => ({
    symbol,
    timeframe,
    time: r.time.getTime(),
    timestamp: r.time.toISOString(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}

/** Upsert completed candles (re-writing overlapping ones picks up vendor corrections). */
export async function saveCandles(
  db: Db,
  symbol: string,
  timeframe: Timeframe,
  candles: ReadonlyArray<Candle>,
  source: string,
): Promise<number> {
  if (candles.length === 0) return 0;
  for (let i = 0; i < candles.length; i += 1000) {
    const rows = candles
      .slice(i, i + 1000)
      .map(
        (c) =>
          Prisma.sql`(${symbol}, ${timeframe}, ${new Date(c.time)}, ${c.open}, ${c.high}, ${c.low}, ${c.close}, ${c.volume}, ${source}, now())`,
      );
    await db.$executeRaw`
      INSERT INTO "MarketCandle" ("symbol", "timeframe", "time", "open", "high", "low", "close", "volume", "source", "updatedAt")
      VALUES ${Prisma.join(rows)}
      ON CONFLICT ("symbol", "timeframe", "time") DO UPDATE SET
        "open" = EXCLUDED."open", "high" = EXCLUDED."high", "low" = EXCLUDED."low",
        "close" = EXCLUDED."close", "volume" = EXCLUDED."volume", "source" = EXCLUDED."source",
        "updatedAt" = now()`;
  }
  return candles.length;
}

/** Merge two ascending series; `newer` wins on identical open times. Keeps the last `limit`. */
export function mergeCandles<C extends Candle>(
  older: ReadonlyArray<C>,
  newer: ReadonlyArray<C>,
  limit: number,
): C[] {
  const byTime = new Map<number, C>();
  for (const c of older) byTime.set(c.time, c);
  for (const c of newer) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-limit);
}
