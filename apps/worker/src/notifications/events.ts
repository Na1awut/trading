import type { Prisma, SignalDefinition } from '@signals/db';
import type { SignalEvaluation } from '@signals/signal-engine';
import { mapWithConcurrency } from '../concurrency';
import { deliverEvent, type DeliveryDeps } from './delivery';
import { DEFAULT_DELIVERY_SETTINGS } from './settings';

export interface FanOutResult {
  created: number;
  duplicates: number;
  notificationsSent: number;
}

/** Rows per INSERT; ~20 columns each keeps a statement well under Postgres' 65535 parameters. */
const INSERT_CHUNK = 500;

/**
 * Record one SignalEvent per enabled subscriber (status PENDING, due now), then attempt
 * delivery of each. Recording and delivery are separate steps: if the process dies in
 * between, the retry sweep delivers the PENDING events later.
 *
 * Recording is one multi-row INSERT ... ON CONFLICT DO NOTHING per chunk, and delivery runs
 * with bounded concurrency (`delivery.concurrency`). Load validation showed the previous
 * one-insert-then-one-send-per-subscriber loop costs ~45 ms per subscriber with a realistic
 * push round trip, i.e. ~45 s for one signal with 1,000 subscribers.
 *
 * Idempotency: the unique (userId, ticker, signalDefinitionId, timeframe, candleTime)
 * constraint skips a second insert for the same candle; skipped rows are counted as
 * duplicates and never re-notified.
 */
export async function fanOutSignal(
  deps: DeliveryDeps,
  def: SignalDefinition,
  evaluation: SignalEvaluation,
  nowMs = Date.now(),
): Promise<FanOutResult> {
  const { prisma } = deps;
  const result: FanOutResult = { created: 0, duplicates: 0, notificationsSent: 0 };
  if (!evaluation.triggered || evaluation.candleTime === null || evaluation.price === null)
    return result;

  const subs = await prisma.signalSubscription.findMany({
    where: { signalDefinitionId: def.id, enabled: true },
    select: { userId: true },
  });

  const shared = {
    signalDefinitionId: def.id,
    ticker: def.ticker,
    signalType: def.signalType,
    category: def.category,
    name: def.name,
    timeframe: def.timeframe,
    candleTime: new Date(evaluation.candleTime),
    triggeredAt: new Date(nowMs),
    price: evaluation.price,
    values: evaluation.values as Prisma.InputJsonObject,
    evidence: (evaluation.evidence ?? undefined) as Prisma.InputJsonObject | undefined,
    message: evaluation.message ?? evaluation.label,
    signalScore: evaluation.evidence?.strength?.score ?? null,
    maxSignalScore: evaluation.evidence?.strength?.maxScore ?? null,
    signalStrength: evaluation.evidence?.strength?.level ?? null,
    notificationStatus: 'PENDING' as const,
    nextNotificationAttemptAt: new Date(nowMs),
  };
  const created: string[] = [];
  for (let i = 0; i < subs.length; i += INSERT_CHUNK) {
    const chunk = subs.slice(i, i + INSERT_CHUNK);
    const rows = await prisma.signalEvent.createManyAndReturn({
      data: chunk.map(({ userId }) => ({ ...shared, userId })),
      skipDuplicates: true,
      select: { id: true },
    });
    for (const r of rows) created.push(r.id);
    result.created += rows.length;
    result.duplicates += chunk.length - rows.length;
  }

  const concurrency = Math.max(
    1,
    deps.delivery?.concurrency ?? DEFAULT_DELIVERY_SETTINGS.concurrency,
  );
  const outcomes = await mapWithConcurrency(created, concurrency, async (id) => {
    try {
      return await deliverEvent(deps, id, nowMs);
    } catch (err) {
      // The event stays PENDING/SENDING and the sweep will retry it.
      deps.logger.error({ err, eventId: id }, 'immediate delivery failed - left for retry sweep');
      return null;
    }
  });
  result.notificationsSent = outcomes.filter((o) => o === 'SENT').length;
  return result;
}
