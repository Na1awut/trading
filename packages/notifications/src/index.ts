import { getFirebaseAdminApp, type FirebaseAdminOptions } from './firebase';
import { ConsoleNotificationSender, FcmNotificationSender } from './senders';
import type { Logger, NotificationSender } from './types';

export * from './types';
export * from './senders';
export * from './firebase';
export * from './signal-notification';

export function createNotificationSender(
  driver: 'console' | 'fcm',
  logger: Logger,
  firebase: FirebaseAdminOptions = {},
): NotificationSender {
  if (driver === 'fcm') return FcmNotificationSender.fromApp(getFirebaseAdminApp(firebase), logger);
  return new ConsoleNotificationSender(logger);
}
export * from './quiet-hours';
