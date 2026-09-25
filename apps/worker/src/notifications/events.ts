import { Prisma, type SignalDefinition } from '@signals/db';
import type { SignalEvaluation } from '@signals/signal-engine';
import { deliverEvent, type DeliveryDeps } from './delivery';

export interface FanOutResult {
  created: number;
  duplicates: number;
  notificationsSent: number;
}

/**
 * Record one SignalEvent per enabled subscriber (status PENDING, due now), then attempt
 * delivery of each. Recording and delivery are separate steps: if the process dies in
 * between, the retry sweep delivers the PENDING events later.
 *
 * Idempotency: the unique (userId, ticker, signalDefinitionId, timeframe, candleTime)
 * constraint rejects a second insert for the same candle (P2002) - duplicates are counted,
 * never re-notified.
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

  const created: string[] = [];
  for (const { userId } of subs) {
    try {
      const event = await prisma.signalEvent.create({
        data: {
          userId,
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
          notificationStatus: 'PENDING',
          nextNotificationAttemptAt: new Date(nowMs),
        },
        select: { id: true },
      });
      created.push(event.id);
      result.created++;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        result.duplicates++;
        continue;
      }
      throw err;
    }
  }

  for (const id of created) {
    try {
      if ((await deliverEvent(deps, id, nowMs)) === 'SENT') result.notificationsSent++;
    } catch (err) {
      // The event stays PENDING/SENDING and the sweep will retry it.
      deps.logger.error({ err, eventId: id }, 'immediate delivery failed - left for retry sweep');
    }
  }
  return result;
}
