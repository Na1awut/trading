# Push notifications

## Flow

1. The app requests permission, gets the native device token (`getDevicePushTokenAsync`),
   and calls `POST /devices/register { token, platform, provider }`. It does this on every
   start, and again whenever the OS rotates the token (`addPushTokenListener`). A user can
   have several devices, capped at `MAX_DEVICES_PER_USER`; the least recently seen are pruned
   first. The token is unregistered on sign-out.
2. When a signal fires, the worker **records** one `SignalEvent` per subscriber
   (`PENDING`), then **delivers** each one through `deliverEvent()`.
3. The notification contains:
   - **Title:** `NVDA — EMA Bullish Cross`
   - **Body:** `EMA 9 crossed above EMA 21 at $182.30 (5m)`
   - **Data:** `{ type: "signal", eventId, symbol, signalType, timeframe, url: "stocksignals://signals/events/<eventId>" }`

   The data holds identifiers only: no user IDs, emails or tokens. The app fetches the
   details from the API after authenticating.

4. Tapping the notification opens `/signals/events/<eventId>`, whether the app is running or
   starting cold. That screen shows the structured explanation.
5. Every event stays in history, whatever happens to its notification.

## Delivery state machine

| Status       | Meaning                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `PENDING`    | Recorded; due at `nextNotificationAttemptAt` (now, or when quiet hours end)                                         |
| `SENDING`    | Claimed by a worker (atomic conditional update)                                                                     |
| `SENT`       | At least one device accepted it                                                                                     |
| `FAILED`     | Retrying if `nextNotificationAttemptAt` is set; otherwise permanent (max attempts, non-retryable error, or expired) |
| `SUPPRESSED` | Preferences prevented the push. `notificationError` holds the reason.                                               |
| `NO_DEVICES` | No valid device token                                                                                               |

Fields: `notificationStatus`, `notificationAttempts`, `lastNotificationAttemptAt`,
`nextNotificationAttemptAt`, `notificationSentAt`, `notificationError`.

### Crash safety

| Failure                                        | What happens                                                                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crash after the event insert, before sending   | The event stays `PENDING`. The retry sweep (every worker cycle) delivers it.                                                                                               |
| Crash during the send                          | The `SENDING` claim goes stale after `NOTIFICATION_SENDING_TIMEOUT_MS`, and the sweep re-claims it (attempt + 1).                                                          |
| Two workers pick the same event                | Only the conditional claim that succeeds sends. Result writes are guarded by the attempt number.                                                                           |
| FCM accepted the message, then the worker died | At-least-once delivery means it is resent. Android `tag` and `apns-collapse-id` are set to the event ID, so the device **replaces** the first copy instead of showing two. |

Retries always resend the **existing** event. They never create a new one, so history
cannot be duplicated. Backoff doubles from `NOTIFICATION_RETRY_BASE_MS` (30 s, 60 s, 120 s,
240 s …), capped by `NOTIFICATION_RETRY_MAX_MS`, for up to `NOTIFICATION_MAX_ATTEMPTS` (5)
attempts. Events older than `NOTIFICATION_MAX_AGE_MS` (24 h) are abandoned rather than sent late.

### Per-device results (FCM)

| FCM error                                                                                       | Handling                                                                   |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `registration-token-not-registered`, `invalid-registration-token`                               | The device is **deleted**. If none remain, the event becomes `NO_DEVICES`. |
| `unavailable`, `internal-error`, `server-unavailable`, `quota-exceeded`, rate exceeded, network | Retry with backoff                                                         |
| Anything else (e.g. `invalid-argument`)                                                         | Permanent failure; no retry                                                |

If any one device succeeds, the event is `SENT`. One bad token never blocks the user's
other devices.

## Preferences (evaluated at send time)

Switches changed while a notification is pending or retrying are respected.

1. Global alerts off → `SUPPRESSED`
2. Ticker alerts off → `SUPPRESSED`
3. Signal (subscription) disabled → `SUPPRESSED`
4. Category disabled → `SUPPRESSED`
5. Strength below `minimumSignalStrength` → `SUPPRESSED`
6. **Quiet hours** → **delayed**: the event stays `PENDING` with
   `nextNotificationAttemptAt` set to the end of the window, and delivery happens then. The
   event is visible in history immediately. A deferral does not count as an attempt.

Quiet hours use the user's IANA `timezone`:

- windows can span midnight (22:00 → 07:00);
- DST transitions are handled, and both US transitions are tested;
- the same instant can be quiet for one user and not another;
- if start equals end, or either is unset, quiet hours are off.

A deferred notification is released at the end time computed when it was deferred.
`notificationFrequency` digests are stored but not implemented.

## Drivers

| `NOTIFICATION_DRIVER` | Behaviour                                                                             |
| --------------------- | ------------------------------------------------------------------------------------- |
| `console` (default)   | Logs `🔔 [push:console] <title> — <body>` and reports success. No credentials needed. |
| `fcm`                 | Firebase Cloud Messaging via `firebase-admin` `sendEach`                              |

## Enabling FCM (manual steps)

1. **Firebase project.** Create one and add an Android app with the package ID from
   `apps/mobile/app.config.ts` (`com.example.stocksignals`; change it to your own).
2. **Server.** Set `NOTIFICATION_DRIVER=fcm` and `FIREBASE_PROJECT_ID`, plus one of:
   - `FIREBASE_SERVICE_ACCOUNT_BASE64` (a secret manager value);
   - `FIREBASE_SERVICE_ACCOUNT_PATH` (a file outside the repository);
   - `GOOGLE_APPLICATION_CREDENTIALS` / workload identity.

   Service-account errors never echo the key material.

3. **Android.** Put `google-services.json` in `apps/mobile/` (it is git-ignored), then build a
   **development or production build** with `npx expo run:android` or EAS Build. The device
   token is an FCM token.
4. **Test.** Use **Settings → Send test notification** in the app, or `POST /devices/test`.
   Then trigger a real signal and tap the notification. It should open
   `/signals/events/<id>`.

### iOS (not yet complete)

`getDevicePushTokenAsync()` on iOS returns a raw **APNs** token, which FCM cannot address.
The app registers it as `provider: "APNS"`, and the FCM sender skips such tokens with a
non-retryable result. To support iOS:

- add `@react-native-firebase/messaging` to obtain an **FCM** token on iOS and register it
  with `provider: "FCM"`;
- upload an APNs auth key in Firebase → Project settings → Cloud Messaging.

Alternatively, implement an APNs `NotificationSender`. The delivery pipeline stays the same.

Remote push does not work in Expo Go (Android, SDK 53+) or in simulators; everything else does.
