import { Prisma, type PrismaClient } from '@signals/db';
import type { Candle, Timeframe } from '@signals/types';

/**
 * Upsert completed candles into MarketCandle (history for audit/backtesting/charts).
 * Re-upserting the recent tail each cycle picks up vendor corrections.
 */
export async function ingestCandles(
  prisma: PrismaClient,
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  source: string,
): Promise<number> {
  if (candles.length === 0) return 0;
  const latest = await prisma.marketCandle.findFirst({
    where: { symbol, timeframe },
    orderBy: { time: 'desc' },
    select: { time: true },
  });
  // First sight of this pair: backfill everything; afterwards only the recent tail.
  const toWrite = latest ? candles.slice(-5) : candles;
  const rows = toWrite.map(
    (c) =>
      Prisma.sql`(${symbol}, ${timeframe}, ${new Date(c.time)}, ${c.open}, ${c.high}, ${c.low}, ${c.close}, ${c.volume}, ${source}, now())`,
  );
  await prisma.$executeRaw`
    INSERT INTO "MarketCandle" ("symbol", "timeframe", "time", "open", "high", "low", "close", "volume", "source", "updatedAt")
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("symbol", "timeframe", "time") DO UPDATE SET
      "open" = EXCLUDED."open", "high" = EXCLUDED."high", "low" = EXCLUDED."low",
      "close" = EXCLUDED."close", "volume" = EXCLUDED."volume", "source" = EXCLUDED."source",
      "updatedAt" = now()`;
  return toWrite.length;
}
