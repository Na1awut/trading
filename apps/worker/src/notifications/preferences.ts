import type { PrismaClient, SignalEvent } from '@signals/db';
import { quietHoursStatus } from '@signals/notifications';
import { strengthRank } from '@signals/types';

export type PreferenceDecision =
  | { action: 'send' }
  | { action: 'suppress'; reason: string }
  | { action: 'defer'; until: Date; reason: string };

/**
 * Notification preferences, evaluated at SEND time (not at event creation), so a user who
 * switches alerts off while a notification is pending or retrying is respected.
 * The SignalEvent itself is always recorded and visible in history.
 */
export async function evaluatePreferences(
  prisma: PrismaClient,
  event: Pick<
    SignalEvent,
    'userId' | 'ticker' | 'category' | 'signalDefinitionId' | 'signalStrength'
  >,
  now: Date,
): Promise<PreferenceDecision> {
  const [settings, watchItem, subscription] = await Promise.all([
    prisma.notificationSettings.findUnique({ where: { userId: event.userId } }),
    prisma.watchlistItem.findFirst({
      where: { symbol: event.ticker, watchlist: { userId: event.userId } },
      select: { alertsEnabled: true },
    }),
    event.signalDefinitionId
      ? prisma.signalSubscription.findUnique({
          where: {
            userId_signalDefinitionId: {
              userId: event.userId,
              signalDefinitionId: event.signalDefinitionId,
            },
          },
          select: { enabled: true },
        })
      : null,
  ]);

  if (settings && !settings.alertsEnabled)
    return { action: 'suppress', reason: 'alerts disabled globally' };
  if (watchItem && !watchItem.alertsEnabled)
    return { action: 'suppress', reason: `alerts disabled for ${event.ticker}` };
  if (!subscription || !subscription.enabled)
    return { action: 'suppress', reason: 'signal disabled' };
  if (settings?.disabledCategories.includes(event.category)) {
    return { action: 'suppress', reason: `${event.category} alerts disabled` };
  }
  if (
    settings &&
    event.signalStrength &&
    strengthRank(event.signalStrength) < strengthRank(settings.minimumSignalStrength)
  ) {
    return {
      action: 'suppress',
      reason: `below minimum strength (${event.signalStrength} < ${settings.minimumSignalStrength})`,
    };
  }
  if (settings) {
    const quiet = quietHoursStatus(
      now.getTime(),
      settings.quietHoursStart,
      settings.quietHoursEnd,
      settings.timezone,
    );
    if (quiet.inQuietHours && quiet.endsAt) {
      return {
        action: 'defer',
        until: quiet.endsAt,
        reason: `quiet hours until ${quiet.endsAt.toISOString()}`,
      };
    }
  }
  return { action: 'send' };
}
