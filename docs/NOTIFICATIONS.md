# Push notifications

## Flow

1. The app requests permission and calls `getDevicePushTokenAsync()` (`apps/mobile/src/notifications/push.ts`).
2. It calls `POST /devices/register { token, platform, provider }`. A token belongs to one
   user; re-registering the token moves it.
3. When a signal fires, the worker sends through the configured `NotificationSender`:
   - title: `NVDA — EMA Bullish Cross`
   - body: `EMA 9 crossed above EMA 21 at $182.30 (1h)`
   - data: `{ type: "signal", eventId, ticker: "NVDA", url: "stocksignals://asset/NVDA" }`
4. Tapping the notification opens `/asset/NVDA`. This works when the app is running and on cold start.
5. Every event is stored in history with a delivery status (`SENT`, `SUPPRESSED`, `NO_DEVICES`, `FAILED`).

## Drivers

| `NOTIFICATION_DRIVER` | Behaviour                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `console` (default)   | Logs `🔔 [push:console] <title> — <body>` in the worker and reports success. No credentials needed.       |
| `fcm`                 | Firebase Cloud Messaging through `firebase-admin` (`sendEach`). Invalid tokens are deleted automatically. |

## Enabling FCM

1. Create a Firebase project and add Android and iOS apps with the IDs in `apps/mobile/app.config.ts`
   (`com.example.stocksignals`; change them to your own).
2. **Server:** set `NOTIFICATION_DRIVER=fcm`, `FIREBASE_PROJECT_ID`, and a service account via
   `FIREBASE_SERVICE_ACCOUNT_PATH` (a file outside the repo), `FIREBASE_SERVICE_ACCOUNT_BASE64`
   (a secret manager value), or `GOOGLE_APPLICATION_CREDENTIALS`.
3. **Android:** download `google-services.json` into `apps/mobile/` (git-ignored) and build a
   development build: `npx expo run:android`. The device token is an FCM token.
4. **iOS:** upload an APNs key to Firebase (Project settings → Cloud Messaging). Note that
   `getDevicePushTokenAsync()` on iOS returns a raw **APNs** token, which FCM cannot address
   directly. The app registers it as `provider: "APNS"`, and the FCM sender skips such tokens.
   To deliver to iOS through FCM, add `@react-native-firebase/messaging` to obtain an FCM token
   and register it with `provider: "FCM"`. Alternatively, add an APNs sender that implements
   `NotificationSender`. The rest of the pipeline is unchanged.
5. Use **Settings → Send test notification** in the app, or `POST /devices/test`.

Remote push does not work in Expo Go (Android, SDK 53+) or in simulators. All other app
features do.
