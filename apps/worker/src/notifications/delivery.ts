import type { Prisma } from '@signals/db';
import { type PrismaClient } from '@signals/db';
import {
  buildSignalNotification,
  type NotificationSender,
  type SendResult,
} from '@signals/notifications';
import { getRule } from '@signals/signal-engine';
import type { Metrics } from '@signals/config';
import type { WorkerLogger } from '../evaluation-cycle';
import { evaluatePreferences } from './preferences';
import { DEFAULT_DELIVERY_SETTINGS, retryDelayMs, type DeliverySettings } from './settings';
import { mapWithConcurrency } from '../concurrency';

export interface DeliveryDeps {
  prisma: PrismaClient;
  notifier: NotificationSender;
  logger: WorkerLogger;
  delivery?: Partial<DeliverySettings>;
  metrics?: Metrics;
}

export type DeliveryOutcome =
  | 'SENT'
  | 'RETRY_SCHEDULED'
  | 'FAILED'
  | 'SUPPRESSED'
  | 'NO_DEVICES'
  | 'DEFERRED'
  | 'EXPIRED'
  | 'NOT_DUE'
  | 'NOT_CLAIMED';

/** Events that may be (re)sent now: due PENDING/FAILED, or a SENDING claim that went stale. */
function claimableWhere(now: Date, s: DeliverySettings): Prisma.SignalEventWhereInput {
  return {
    notificationAttempts: { lt: s.maxAttempts },
    OR: [
      {
        notificationStatus: { in: ['PENDING', 'FAILED'] },
        nextNotificationAttemptAt: { lte: now },
      },
      {
        notificationStatus: 'SENDING',
        lastNotificationAttemptAt: { lt: new Date(now.getTime() - s.sendingTimeoutMs) },
      },
    ],
  };
}

/**
 * Deliver (or re-deliver) ONE existing SignalEvent. Never creates events, so retries can
 * never duplicate history. Safe to call concurrently from many workers: only the caller
 * whose conditional UPDATE claims the event sends it, and result writes are guarded by the
 * claimed attempt number (a slow, timed-out claimer cannot overwrite a newer attempt).
 *
 * Delivery is at-least-once: if a worker dies after FCM accepted the message but before the
 * status write, the claim goes stale and the event is re-sent. FCM tag / APNs collapse id
 * (= event id) make the device replace the first copy instead of showing two.
 */
export async function deliverEvent(
  deps: DeliveryDeps,
  eventId: string,
  nowMs = Date.now(),
): Promise<DeliveryOutcome> {
  const outcome = await deliverEventInner(deps, eventId, nowMs);
  const m = deps.metrics;
  if (m && outcome !== 'NOT_DUE' && outcome !== 'NOT_CLAIMED') {
    m.inc('notification_deliveries_total', { outcome });
    if (outcome === 'SENT') m.inc('notifications_sent_total');
    if (outcome === 'RETRY_SCHEDULED') m.inc('notification_failures_total', { permanent: false });
    if (outcome === 'FAILED' || outcome === 'EXPIRED')
      m.inc('notification_failures_total', { permanent: true });
  }
  return outcome;
}

async function deliverEventInner(
  deps: DeliveryDeps,
  eventId: string,
  nowMs: number,
): Promise<DeliveryOutcome> {
  const s = { ...DEFAULT_DELIVERY_SETTINGS, ...deps.delivery };
  const now = new Date(nowMs);
  const { prisma } = deps;

  const event = await prisma.signalEvent.findFirst({
    where: { id: eventId, ...claimableWhere(now, s) },
  });
  if (!event) return 'NOT_DUE';
  const guard = {
    id: event.id,
    notificationAttempts: event.notificationAttempts,
    notificationStatus: event.notificationStatus,
  };

  if (nowMs - event.triggeredAt.getTime() > s.maxAgeMs) {
    await prisma.signalEvent.updateMany({
      where: guard,
      data: {
        notificationStatus: 'FAILED',
        nextNotificationAttemptAt: null,
        notificationError: 'expired before delivery',
      },
    });
    return 'EXPIRED';
  }

  const decision = await evaluatePreferences(prisma, event, now);
  if (decision.action === 'suppress') {
    await prisma.signalEvent.updateMany({
      where: guard,
      data: {
        notificationStatus: 'SUPPRESSED',
        nextNotificationAttemptAt: null,
        notificationError: decision.reason,
      },
    });
    return 'SUPPRESSED';
  }
  if (decision.action === 'defer') {
    // Not an attempt: keep it PENDING and due when quiet hours end.
    await prisma.signalEvent.updateMany({
      where: guard,
      data: {
        notificationStatus: 'PENDING',
        nextNotificationAttemptAt: decision.until,
        notificationError: decision.reason,
      },
    });
    return 'DEFERRED';
  }

  // Atomic claim (optimistic concurrency on the attempt counter).
  const attempt = event.notificationAttempts + 1;
  const claim = await prisma.signalEvent.updateMany({
    where: { ...guard, ...claimableWhere(now, s) },
    data: {
      notificationStatus: 'SENDING',
      notificationAttempts: attempt,
      lastNotificationAttemptAt: now,
    },
  });
  if (claim.count !== 1) return 'NOT_CLAIMED';
  if (attempt > 1) deps.metrics?.inc('notification_retries_total');
  const mine = {
    id: event.id,
    notificationAttempts: attempt,
    notificationStatus: 'SENDING' as const,
  };

  const devices = await prisma.device.findMany({ where: { userId: event.userId } });
  if (devices.length === 0) {
    await prisma.signalEvent.updateMany({
      where: mine,
      data: { notificationStatus: 'NO_DEVICES', nextNotificationAttemptAt: null },
    });
    return 'NO_DEVICES';
  }

  const message = buildSignalNotification({
    eventId: event.id,
    symbol: event.ticker,
    signalType: event.signalType,
    label: getRule(event.signalType).label,
    message: event.message,
    timeframe: event.timeframe,
  });

  let results: SendResult[] | null = null;
  let sendError: string | null = null;
  try {
    results = await deps.notifier.send(
      devices.map((d) => ({ token: d.token, provider: d.provider, platform: d.platform })),
      message,
    );
  } catch (err) {
    sendError = String((err as Error)?.message ?? err).slice(0, 300);
  }

  const invalid = results?.filter((r) => r.invalidToken).map((r) => r.token) ?? [];
  if (invalid.length > 0) {
    await prisma.device.deleteMany({ where: { token: { in: invalid } } });
    deps.logger.info(
      { userId: event.userId, removed: invalid.length },
      'removed invalid push tokens',
    );
  }

  const log = { eventId: event.id, symbol: event.ticker, attempt, devices: devices.length };
  if (results?.some((r) => r.success)) {
    await prisma.signalEvent.updateMany({
      where: mine,
      data: {
        notificationStatus: 'SENT',
        notificationSentAt: now,
        nextNotificationAttemptAt: null,
        notificationError: null,
      },
    });
    deps.logger.info(
      { ...log, delivered: results.filter((r) => r.success).length },
      'notification sent',
    );
    return 'SENT';
  }

  const error =
    sendError ??
    results
      ?.map((r) => r.error)
      .filter(Boolean)
      .join('; ')
      .slice(0, 500) ??
    'unknown';
  if (results && results.every((r) => r.invalidToken)) {
    await prisma.signalEvent.updateMany({
      where: mine,
      data: {
        notificationStatus: 'NO_DEVICES',
        nextNotificationAttemptAt: null,
        notificationError: 'all device tokens invalid',
      },
    });
    return 'NO_DEVICES';
  }
  const retryable = sendError !== null || (results?.some((r) => r.retryable) ?? false);
  if (!retryable || attempt >= s.maxAttempts) {
    await prisma.signalEvent.updateMany({
      where: mine,
      data: {
        notificationStatus: 'FAILED',
        nextNotificationAttemptAt: null,
        notificationError: retryable
          ? `gave up after ${attempt} attempts: ${error}`
          : `permanent failure: ${error}`,
      },
    });
    deps.logger.warn({ ...log, error }, 'notification failed permanently');
    return 'FAILED';
  }
  const next = new Date(nowMs + retryDelayMs(attempt, s));
  await prisma.signalEvent.updateMany({
    where: mine,
    data: {
      notificationStatus: 'FAILED',
      nextNotificationAttemptAt: next,
      notificationError: error,
    },
  });
  deps.logger.warn(
    { ...log, error, retryAt: next.toISOString() },
    'notification failed - retry scheduled',
  );
  return 'RETRY_SCHEDULED';
}

/** Notifications still owed: due or scheduled PENDING/FAILED plus in-flight SENDING. */
export async function countPendingNotifications(prisma: PrismaClient): Promise<number> {
  return prisma.signalEvent.count({
    where: {
      OR: [
        {
          notificationStatus: { in: ['PENDING', 'FAILED'] },
          nextNotificationAttemptAt: { not: null },
        },
        { notificationStatus: 'SENDING' },
      ],
    },
  });
}

export interface SweepSummary {
  candidates: number;
  outcomes: Partial<Record<DeliveryOutcome, number>>;
}

/**
 * Retry sweep: re-deliver due PENDING (crash after insert, end of quiet hours), FAILED
 * (back-off elapsed) and stale SENDING (crash mid-send) events. Bounded per run.
 */
export async function runNotificationSweep(
  deps: DeliveryDeps,
  nowMs = Date.now(),
): Promise<SweepSummary> {
  const s = { ...DEFAULT_DELIVERY_SETTINGS, ...deps.delivery };
  const due = await deps.prisma.signalEvent.findMany({
    where: claimableWhere(new Date(nowMs), s),
    orderBy: { nextNotificationAttemptAt: 'asc' },
    take: s.sweepBatch,
    select: { id: true },
  });
  const summary: SweepSummary = { candidates: due.length, outcomes: {} };
  await mapWithConcurrency(due, Math.max(1, s.concurrency), async ({ id }) => {
    try {
      const outcome = await deliverEvent(deps, id, nowMs);
      summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
    } catch (err) {
      deps.logger.error({ err, eventId: id }, 'delivery sweep error');
    }
  });
  return summary;
}
