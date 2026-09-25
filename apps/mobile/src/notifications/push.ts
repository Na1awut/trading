import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export type PushStatus = 'idle' | 'registered' | 'denied' | 'unsupported' | 'error';

const TOKEN_KEY = 'push-token';
const platform = () => (Platform.OS === 'ios' ? 'ios' : 'android');
const provider = () => (Platform.OS === 'ios' ? ('APNS' as const) : ('FCM' as const));

async function registerToken(token: string) {
  await api.registerDevice({ token, platform: platform(), provider: provider() });
  await AsyncStorage.setItem(TOKEN_KEY, token);
}

/**
 * Registers the native device push token with the API (every app start: refreshes lastSeenAt).
 * - Android: FCM registration token (needs google-services.json in a development build).
 * - iOS: APNs token. Delivering via FCM to iOS additionally needs an FCM token
 *   (@react-native-firebase/messaging) - see docs/NOTIFICATIONS.md.
 * Remote push does not work in Expo Go or simulators; the rest of the app still does.
 */
export async function registerForPush(): Promise<{
  status: PushStatus;
  token?: string;
  error?: string;
}> {
  if (Platform.OS === 'web' || !Device.isDevice) return { status: 'unsupported' };
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('signals', {
        name: 'Signal alerts',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
    if (status !== 'granted') return { status: 'denied' };

    const { data: token } = await Notifications.getDevicePushTokenAsync();
    await registerToken(String(token));
    return { status: 'registered', token: String(token) };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

/** Remove this device's token from the account (called before sign-out). */
export async function unregisterPush(): Promise<void> {
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  if (!token) return;
  await api.unregisterDevice(token).catch(() => undefined);
  await AsyncStorage.removeItem(TOKEN_KEY);
}

/** Deep link target for a notification: the event explanation, or the asset as a fallback. */
export function notificationTarget(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  if (typeof data.eventId === 'string' && data.eventId)
    return `/signals/events/${encodeURIComponent(data.eventId)}`;
  const symbol =
    typeof data.symbol === 'string'
      ? data.symbol
      : typeof data.ticker === 'string'
        ? data.ticker
        : null;
  return symbol ? `/asset/${encodeURIComponent(symbol)}` : null;
}

function openFromNotification(response: Notifications.NotificationResponse | null) {
  const target = notificationTarget(
    response?.notification.request.content.data as Record<string, unknown>,
  );
  if (target) router.push(target as never);
}

/**
 * On sign-in: register the token, re-register when the OS rotates it, deep-link on tap
 * (including cold start), and unregister on sign-out.
 */
export function usePushNotifications(enabled: boolean): PushStatus {
  const [status, setStatus] = useState<PushStatus>('idle');
  const { setBeforeSignOut } = useAuth();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void registerForPush().then((r) => !cancelled && setStatus(r.status));
    setBeforeSignOut(unregisterPush);
    return () => {
      cancelled = true;
      setBeforeSignOut(null);
    };
  }, [enabled, setBeforeSignOut]);

  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return;
    // FCM/APNs can rotate tokens at any time; keep the server in sync.
    const tokenSub = Notifications.addPushTokenListener(({ data }) => {
      void registerToken(String(data)).catch(() => undefined);
    });
    // Cold start: app opened by tapping a notification.
    void Notifications.getLastNotificationResponseAsync().then(openFromNotification);
    const responseSub = Notifications.addNotificationResponseReceivedListener(openFromNotification);
    return () => {
      tokenSub.remove();
      responseSub.remove();
    };
  }, [enabled]);

  return status;
}
