import { Prisma, type PrismaClient, type SignalDefinition } from '@signals/db';
import { buildSignalNotification, type Logger, type NotificationSender } from '@signals/notifications';
import type { SignalEvaluation } from '@signals/signal-engine';

export interface FanOutResult {
  created: number;
  duplicates: number;
  notificationsSent: number;
}

/**
 * Create one SignalEvent per enabled subscriber and deliver notifications.
 *
 * Idempotency: the unique (userId, ticker, signalDefinitionId, timeframe, candleTime)
 * constraint means a second insert for the same candle fails with P2002. Only the process
 * whose insert SUCCEEDED sends the notification, so retries, restarts and concurrent
 * workers can never double-notify.
 */
export async function fanOutSignal(
  deps: { prisma: PrismaClient; notifier: NotificationSender; logger: Logger },
  def: SignalDefinition,
  evaluation: SignalEvaluation,
): Promise<FanOutResult> {
  const { prisma, notifier, logger } = deps;
  const result: FanOutResult = { created: 0, duplicates: 0, notificationsSent: 0 };
  if (!evaluation.triggered || evaluation.candleTime === null || evaluation.price === null) return result;

  const subs = await prisma.signalSubscription.findMany({
    where: { signalDefinitionId: def.id, enabled: true },
    select: { userId: true },
  });
  if (subs.length === 0) return result;
  const userIds = subs.map((s) => s.userId);

  const [settings, watchItems, devices] = await Promise.all([
    prisma.notificationSettings.findMany({ where: { userId: { in: userIds } } }),
    prisma.watchlistItem.findMany({
      where: { symbol: def.ticker, watchlist: { userId: { in: userIds } } },
      select: { alertsEnabled: true, watchlist: { select: { userId: true } } },
    }),
    prisma.device.findMany({ where: { userId: { in: userIds } } }),
  ]);
  const settingsByUser = new Map(settings.map((s) => [s.userId, s]));
  const tickerAlertsByUser = new Map(watchItems.map((w) => [w.watchlist.userId, w.alertsEnabled]));

  for (const userId of userIds) {
    let eventId: string;
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
          price: evaluation.price,
          values: evaluation.values as Prisma.InputJsonObject,
          message: evaluation.message ?? evaluation.label,
        },
      });
      eventId = event.id;
      result.created++;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        result.duplicates++;
        continue; // already recorded (and notified) for this candle
      }
      throw err;
    }

    const s = settingsByUser.get(userId);
    const suppressReason =
      s && !s.alertsEnabled
        ? 'alerts disabled globally'
        : tickerAlertsByUser.get(userId) === false
          ? `alerts disabled for ${def.ticker}`
          : s?.disabledCategories.includes(def.category)
            ? `${def.category} alerts disabled`
            : null;
    if (suppressReason) {
      await prisma.signalEvent.update({
        where: { id: eventId },
        data: { deliveryStatus: 'SUPPRESSED', deliveryError: suppressReason },
      });
      continue;
    }

    const userDevices = devices.filter((d) => d.userId === userId);
    if (userDevices.length === 0) {
      await prisma.signalEvent.update({ where: { id: eventId }, data: { deliveryStatus: 'NO_DEVICES' } });
      continue;
    }

    const message = buildSignalNotification({
      eventId,
      ticker: def.ticker,
      label: evaluation.label,
      message: evaluation.message ?? evaluation.label,
      timeframe: def.timeframe,
    });
    try {
      const sends = await notifier.send(
        userDevices.map((d) => ({ token: d.token, provider: d.provider, platform: d.platform })),
        message,
      );
      const invalid = sends.filter((r) => r.invalidToken).map((r) => r.token);
      if (invalid.length > 0) {
        await prisma.device.deleteMany({ where: { token: { in: invalid } } });
        logger.info({ userId, removed: invalid.length }, 'removed invalid push tokens');
      }
      const ok = sends.some((r) => r.success);
      await prisma.signalEvent.update({
        where: { id: eventId },
        data: ok
          ? { deliveryStatus: 'SENT', deliveredAt: new Date() }
          : { deliveryStatus: 'FAILED', deliveryError: sends.map((r) => r.error).filter(Boolean).join('; ').slice(0, 500) },
      });
      if (ok) result.notificationsSent++;
    } catch (err) {
      logger.error({ err, eventId }, 'notification send failed');
      await prisma.signalEvent.update({
        where: { id: eventId },
        data: { deliveryStatus: 'FAILED', deliveryError: String(err).slice(0, 500) },
      });
    }
  }
  return result;
}
