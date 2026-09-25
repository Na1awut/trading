import type { App } from 'firebase-admin/app';
import { getMessaging, type BatchResponse, type Message } from 'firebase-admin/messaging';
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

/** Test adapter that records every message. Configure per-token outcomes. */
export class RecordingNotificationSender implements NotificationSender {
  readonly name = 'recording';
  readonly sent: { targets: PushTarget[]; message: PushMessage }[] = [];
  /** Tokens that should report as permanently invalid. */
  readonly invalidTokens = new Set<string>();
  /** Tokens that fail with a retryable error (e.g. FCM unavailable). */
  readonly transientFailures = new Set<string>();
  /** Tokens that fail with a non-retryable error. */
  readonly permanentFailures = new Set<string>();
  /** When set, send() throws (e.g. network outage before any per-device result). */
  throwOnSend: Error | null = null;

  async send(targets: PushTarget[], message: PushMessage): Promise<SendResult[]> {
    if (this.throwOnSend) throw this.throwOnSend;
    this.sent.push({ targets, message });
    return targets.map((t): SendResult => {
      if (this.invalidTokens.has(t.token)) {
        return { token: t.token, success: false, error: 'not registered', invalidToken: true };
      }
      if (this.transientFailures.has(t.token)) {
        return { token: t.token, success: false, error: 'messaging/unavailable', retryable: true };
      }
      if (this.permanentFailures.has(t.token)) {
        return {
          token: t.token,
          success: false,
          error: 'messaging/invalid-argument',
          retryable: false,
        };
      }
      return { token: t.token, success: true };
    });
  }
}

/** Tokens that will never work again: delete the device. */
const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);
/** Transient FCM failures: retry with back-off. */
const RETRYABLE_CODES = new Set([
  'messaging/unavailable',
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
  'messaging/quota-exceeded',
  'app/network-error',
]);

/** The part of firebase-admin Messaging we use - injectable for tests. */
export interface MessagingClient {
  sendEach(messages: Message[]): Promise<BatchResponse>;
}

/**
 * Firebase Cloud Messaging adapter.
 * - Android: device registers its native FCM token (expo-notifications getDevicePushTokenAsync).
 * - iOS: requires an APNs key in the Firebase project and an FCM registration token on the
 *   device (e.g. via @react-native-firebase/messaging). Raw APNs tokens are skipped here -
 *   see docs/NOTIFICATIONS.md.
 * Each device gets its own result, so one bad token never blocks the user's other devices.
 */
export class FcmNotificationSender implements NotificationSender {
  readonly name = 'fcm';
  constructor(
    private readonly messaging: MessagingClient,
    private readonly logger: Logger,
  ) {}

  static fromApp(app: App, logger: Logger): FcmNotificationSender {
    return new FcmNotificationSender(getMessaging(app), logger);
  }

  async send(targets: PushTarget[], message: PushMessage): Promise<SendResult[]> {
    const fcmTargets = targets.filter((t) => t.provider === 'FCM');
    const skipped: SendResult[] = targets
      .filter((t) => t.provider !== 'FCM')
      .map((t) => ({
        token: t.token,
        success: false,
        retryable: false,
        error: `provider ${t.provider} not supported by FCM sender`,
      }));
    if (fcmTargets.length === 0) return skipped;

    const messages = fcmTargets.map((t) => buildFcmMessage(t.token, message));
    const response = await this.messaging.sendEach(messages);
    const results = response.responses.map((r, i): SendResult => {
      const token = fcmTargets[i]!.token;
      if (r.success) return { token, success: true };
      const code = r.error?.code ?? 'unknown';
      return {
        token,
        success: false,
        error: code,
        invalidToken: INVALID_TOKEN_CODES.has(code),
        retryable: RETRYABLE_CODES.has(code),
      };
    });
    if (response.failureCount > 0) {
      this.logger.warn(
        {
          failures: response.failureCount,
          codes: results.filter((r) => !r.success).map((r) => r.error),
        },
        'FCM delivery failures',
      );
    }
    return [...results, ...skipped];
  }
}

/** FCM message for one device. Exported for tests. */
export function buildFcmMessage(token: string, message: PushMessage): Message {
  return {
    token,
    notification: { title: message.title, body: message.body },
    data: message.data,
    android: {
      priority: 'high',
      notification: {
        channelId: 'signals',
        ...(message.collapseId ? { tag: message.collapseId } : {}),
      },
    },
    apns: {
      ...(message.collapseId ? { headers: { 'apns-collapse-id': message.collapseId } } : {}),
      payload: { aps: { sound: 'default' } },
    },
  };
}
