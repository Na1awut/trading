import type { App } from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Logger, NotificationSender, PushMessage, PushTarget, SendResult } from './types';

/**
 * Development adapter: logs the notification instead of sending it. Every "send"
 * succeeds, so the full pipeline (event -> notification -> delivery status) is exercised
 * locally without Firebase credentials.
 */
export class ConsoleNotificationSender implements NotificationSender {
  readonly name = 'console';
  constructor(private readonly logger: Logger) {}

  async send(targets: PushTarget[], message: PushMessage): Promise<SendResult[]> {
    this.logger.info(
      { devices: targets.length, title: message.title, body: message.body, data: message.data },
      `🔔 [push:console] ${message.title} — ${message.body}`,
    );
    return targets.map((t) => ({ token: t.token, success: true }));
  }
}

/** Test adapter that records every message. */
export class RecordingNotificationSender implements NotificationSender {
  readonly name = 'recording';
  readonly sent: { targets: PushTarget[]; message: PushMessage }[] = [];
  /** Tokens that should report as permanently invalid. */
  readonly invalidTokens = new Set<string>();

  async send(targets: PushTarget[], message: PushMessage): Promise<SendResult[]> {
    this.sent.push({ targets, message });
    return targets.map((t) =>
      this.invalidTokens.has(t.token)
        ? { token: t.token, success: false, error: 'not registered', invalidToken: true }
        : { token: t.token, success: true },
    );
  }
}

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Firebase Cloud Messaging adapter.
 * - Android: device registers its native FCM token (expo-notifications getDevicePushTokenAsync).
 * - iOS: requires an APNs key uploaded to the Firebase project and an FCM registration
 *   token on the device (e.g. via @react-native-firebase/messaging). Raw APNs tokens are
 *   skipped here - see docs/NOTIFICATIONS.md.
 */
export class FcmNotificationSender implements NotificationSender {
  readonly name = 'fcm';
  constructor(
    private readonly app: App,
    private readonly logger: Logger,
  ) {}

  async send(targets: PushTarget[], message: PushMessage): Promise<SendResult[]> {
    const fcmTargets = targets.filter((t) => t.provider === 'FCM');
    const skipped: SendResult[] = targets
      .filter((t) => t.provider !== 'FCM')
      .map((t) => ({
        token: t.token,
        success: false,
        error: `provider ${t.provider} not supported by FCM sender`,
      }));
    if (fcmTargets.length === 0) return skipped;

    const messages: Message[] = fcmTargets.map((t) => ({
      token: t.token,
      notification: { title: message.title, body: message.body },
      data: message.data,
      android: { priority: 'high', notification: { channelId: 'signals' } },
      apns: { payload: { aps: { sound: 'default' } } },
    }));

    const response = await getMessaging(this.app).sendEach(messages);
    const results = response.responses.map((r, i): SendResult => {
      const token = fcmTargets[i]!.token;
      if (r.success) return { token, success: true };
      const code = r.error?.code ?? 'unknown';
      return { token, success: false, error: code, invalidToken: INVALID_TOKEN_CODES.has(code) };
    });
    if (response.failureCount > 0) {
      this.logger.warn({ failures: response.failureCount }, 'FCM delivery failures');
    }
    return [...results, ...skipped];
  }
}
