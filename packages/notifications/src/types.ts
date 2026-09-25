export type PushProvider = 'FCM' | 'APNS' | 'EXPO';

export interface PushTarget {
  token: string;
  provider: PushProvider;
  platform: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** String-only payload (FCM requirement). Used for deep links on tap. */
  data: Record<string, string>;
}

export interface SendResult {
  token: string;
  success: boolean;
  error?: string;
  /** Token is permanently invalid (app uninstalled, etc.) and should be deleted. */
  invalidToken?: boolean;
}

export interface NotificationSender {
  readonly name: string;
  send(targets: PushTarget[], message: PushMessage): Promise<SendResult[]>;
}

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}
