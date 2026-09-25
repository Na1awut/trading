import type {
  NotificationSettings as DbSettings,
  SignalDefinition,
  SignalEvent,
  SignalSubscription,
} from '@prisma/client';
import type {
  NotificationSettings,
  SignalDTO,
  SignalEventDTO,
  SignalEvidence,
  SignalParameters,
  SignalValues,
  Timeframe,
} from '@signals/types';

export function toSignalDTO(
  sub: SignalSubscription & { signalDefinition: SignalDefinition },
): SignalDTO {
  const d = sub.signalDefinition;
  return {
    id: sub.id,
    signalDefinitionId: d.id,
    name: d.name,
    description: d.description,
    category: d.category,
    signalType: d.signalType,
    ticker: d.ticker,
    timeframe: d.timeframe as Timeframe,
    parameters: d.parameters as SignalParameters,
    enabled: sub.enabled && d.enabled,
    isPreset: d.ownerId === null,
    createdAt: sub.createdAt.toISOString(),
  };
}

export function toSignalEventDTO(e: SignalEvent, currency = 'USD'): SignalEventDTO {
  return {
    id: e.id,
    ticker: e.ticker,
    currency,
    signalDefinitionId: e.signalDefinitionId,
    signalType: e.signalType,
    category: e.category,
    name: e.name,
    timeframe: e.timeframe as Timeframe,
    triggeredAt: e.triggeredAt.toISOString(),
    candleTime: e.candleTime.toISOString(),
    price: e.price,
    values: e.values as SignalValues,
    evidence: (e.evidence as SignalEvidence | null) ?? null,
    signalScore: e.signalScore,
    maxSignalScore: e.maxSignalScore,
    signalStrength: e.signalStrength,
    message: e.message,
    notificationStatus: e.notificationStatus,
    notificationSentAt: e.notificationSentAt?.toISOString() ?? null,
    nextNotificationAttemptAt: e.nextNotificationAttemptAt?.toISOString() ?? null,
  };
}

export function toSettingsDTO(s: DbSettings): NotificationSettings {
  return {
    alertsEnabled: s.alertsEnabled,
    disabledCategories: s.disabledCategories,
    quietHoursStart: s.quietHoursStart,
    quietHoursEnd: s.quietHoursEnd,
    timezone: s.timezone,
    notificationFrequency: s.notificationFrequency,
    minimumSignalStrength: s.minimumSignalStrength,
  };
}
