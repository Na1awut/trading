import type { PrismaClient } from '@signals/db';
import { TIMEFRAMES, type Timeframe } from '@signals/types';

/** Days of MarketCandle history to keep per timeframe; 0 = keep forever. */
export type RetentionPolicy = Record<Timeframe, number>;

const DAY = 86_400_000;

/**
 * Delete MarketCandle rows older than the policy allows. Deletes go per (symbol, timeframe)
 * through the primary-key index (symbol, timeframe, time) in bounded chunks, so the job
 * never needs an extra index and never holds long locks. Idempotent: safe to run on
 * several worker instances.
 */
export async function runCandleRetention(
  prisma: PrismaClient,
  policy: RetentionPolicy,
  nowMs = Date.now(),
  chunk = 5_000,
): Promise<{ deleted: Partial<Record<Timeframe, number>> }> {
  const symbols = (await prisma.asset.findMany({ select: { symbol: true } })).map((a) => a.symbol);
  const deleted: Partial<Record<Timeframe, number>> = {};
  for (const tf of TIMEFRAMES) {
    const days = policy[tf];
    if (!days || days <= 0) continue;
    const cutoff = new Date(nowMs - days * DAY);
    let total = 0;
    for (const symbol of symbols) {
      for (;;) {
        const n = await prisma.$executeRaw`
          DELETE FROM "MarketCandle" WHERE ctid IN (
            SELECT ctid FROM "MarketCandle"
            WHERE "symbol" = ${symbol} AND "timeframe" = ${tf} AND "time" < ${cutoff}
            LIMIT ${chunk}
          )`;
        total += n;
        if (n < chunk) break;
      }
    }
    deleted[tf] = total;
  }
  return { deleted };
}
