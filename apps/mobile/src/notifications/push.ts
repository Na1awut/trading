import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { api } from '../api/client';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export type PushStatus = 'idle' | 'registered' | 'denied' | 'unsupported' | 'error';

/**
 * Registers the native device push token with the API.
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
    await api.registerDevice({
      token: String(token),
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      provider: Platform.OS === 'ios' ? 'APNS' : 'FCM',
    });
    return { status: 'registered', token: String(token) };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

function openFromNotification(response: Notifications.NotificationResponse | null) {
  const data = response?.notification.request.content.data as { ticker?: string } | undefined;
  if (data?.ticker) router.push(`/asset/${encodeURIComponent(data.ticker)}`);
}

/** Register on sign-in and deep-link to the asset screen when a notification is tapped. */
export function usePushNotifications(enabled: boolean): PushStatus {
  const [status, setStatus] = useState<PushStatus>('idle');

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void registerForPush().then((r) => !cancelled && setStatus(r.status));
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return;
    // Cold start: app opened by tapping a notification.
    void Notifications.getLastNotificationResponseAsync().then(openFromNotification);
    const sub = Notifications.addNotificationResponseReceivedListener(openFromNotification);
    return () => sub.remove();
  }, [enabled]);

  return status;
}
