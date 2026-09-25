/**
 * Push notification validation (Phase 3, step 5).
 *
 *   # Payload audit only (no credentials): builds the exact FCM messages for real stored events
 *   pnpm --filter @signals/worker validate:push --audit-only [--database-url <url>]
 *
 *   # Against Firebase (needs FIREBASE_PROJECT_ID + service account, and a device registered
 *   # by the app on a PHYSICAL Android phone signed in as <email>):
 *   pnpm --filter @signals/worker validate:push --email you@example.com [--no-deliver]
 *
 * With credentials it: (1) validates every message with FCM's dry-run (real API call, nothing
 * delivered), (2) sends the latest real SignalEvent of that user to each of their devices
 * through the production FcmNotificationSender, and (3) sends to a malformed token to confirm
 * how FCM's error is classified. It never prints tokens (only the last 6 characters), never
 * changes stored delivery state, and never creates events: the event must come from the
 * worker evaluating real market data.
 *
 * What it cannot verify: that the phone displayed the notification, or what happened on
 * tap. Follow the device protocol in docs/REAL_WORLD_VALIDATION.md for that.
 */
import { loadConfig } from '@signals/config';
import { createPrismaClient } from '@signals/db';
import {
  FcmNotificationSender,
  buildFcmMessage,
  buildSignalNotification,
  getFirebaseAdminApp,
} from '@signals/notifications';
import { getRule } from '@signals/signal-engine';
import { getMessaging } from 'firebase-admin/messaging';
import { Report, VALIDATION_DB_URL } from './lib';

const has = (f: string) => process.argv.includes(`--${f}`);
const opt = (f: string) => {
  const i = process.argv.indexOf(`--${f}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const mask = (token: string) => `…${token.slice(-6)}`;
const ALLOWED_DATA_KEYS = ['eventId', 'signalType', 'symbol', 'timeframe', 'type', 'url'];
const FORBIDDEN = /email|user|uid|token|apikey|api_key|secret|password|evidence|firebase/i;
const FCM_MAX_BYTES = 4096;

const report = new Report('Push notification validation');

async function main() {
  const auditOnly = has('audit-only');
  const email = opt('email');
  const dbUrl = opt('database-url') ?? (auditOnly ? VALIDATION_DB_URL : loadConfig().DATABASE_URL);
  const prisma = createPrismaClient(dbUrl);

  const user = email ? await prisma.user.findFirst({ where: { email } }) : null;
  if (email && !user) throw new Error(`No user with that email in the database`);
  const events = await prisma.signalEvent.findMany({
    where: user ? { userId: user.id } : {},
    orderBy: { triggeredAt: 'desc' },
    take: auditOnly ? 25 : 1,
  });
  if (events.length === 0) {
    throw new Error(
      'No SignalEvent to audit. Let the worker run until a signal triggers (the script never creates events).',
    );
  }

  // 1. Payload audit on the exact messages the sender would build.
  for (const e of events) {
    const push = buildSignalNotification({
      eventId: e.id,
      symbol: e.ticker,
      signalType: e.signalType,
      label: getRule(e.signalType as never).label,
      message: e.message,
      timeframe: e.timeframe,
    });
    const msg = buildFcmMessage('TOKEN-PLACEHOLDER', push);
    const data = msg.data ?? {};
    const keys = Object.keys(data).sort();
    const size = Buffer.byteLength(JSON.stringify({ notification: msg.notification, data }));
    const leaks = Object.entries(data).filter(
      ([k, v]) =>
        FORBIDDEN.test(k) || (user && (v.includes(user.id) || (email && v.includes(email)))),
    );
    report.check(
      'payload',
      `${e.ticker} ${e.signalType} ${e.timeframe}: data holds identifiers only`,
      JSON.stringify(keys) === JSON.stringify(ALLOWED_DATA_KEYS) &&
        leaks.length === 0 &&
        Object.values(data).every((v) => typeof v === 'string'),
      `keys=${keys.join(',')}`,
    );
    report.check(
      'payload',
      `${e.ticker} ${e.signalType}: deep link targets /signals/events/:id`,
      data.url === `stocksignals://signals/events/${encodeURIComponent(e.id)}` &&
        data.eventId === e.id,
      data.url ?? '',
    );
    report.check(
      'payload',
      `${e.ticker} ${e.signalType}: size within FCM's 4 KB limit, collapses by event id`,
      size < FCM_MAX_BYTES &&
        msg.android?.notification?.tag === e.id &&
        msg.android?.notification?.channelId === 'signals',
      `${size} bytes`,
    );
  }
  const sample = buildFcmMessage(
    'TOKEN-PLACEHOLDER',
    buildSignalNotification({
      eventId: events[0]!.id,
      symbol: events[0]!.ticker,
      signalType: events[0]!.signalType,
      label: getRule(events[0]!.signalType as never).label,
      message: events[0]!.message,
      timeframe: events[0]!.timeframe,
    }),
  );
  report.note(`Sample FCM message (token redacted): ${JSON.stringify(sample)}`);

  if (auditOnly) {
    report.note(
      `Audit-only: ${events.length} stored events from ${dbUrl.replace(/\/\/[^@]*@/, '//***@')}. No message was sent to Firebase.`,
    );
    return finish(prisma);
  }

  // 2. Real FCM.
  const config = loadConfig();
  if (!config.FIREBASE_PROJECT_ID) throw new Error('FIREBASE_PROJECT_ID is not set');
  const app = getFirebaseAdminApp({
    projectId: config.FIREBASE_PROJECT_ID,
    serviceAccountPath: config.FIREBASE_SERVICE_ACCOUNT_PATH,
    serviceAccountBase64: config.FIREBASE_SERVICE_ACCOUNT_BASE64,
  });
  const devices = await prisma.device.findMany({ where: { userId: user!.id } });
  report.check(
    'devices',
    'user has at least one FCM device registered by the app',
    devices.some((d) => d.provider === 'FCM'),
    devices
      .map((d) => `${d.platform}/${d.provider} ${mask(d.token)} seen ${d.lastSeenAt.toISOString()}`)
      .join('; '),
  );
  const e = events[0]!;
  const push = buildSignalNotification({
    eventId: e.id,
    symbol: e.ticker,
    signalType: e.signalType,
    label: getRule(e.signalType as never).label,
    message: e.message,
    timeframe: e.timeframe,
  });
  const messaging = getMessaging(app);
  for (const d of devices.filter((x) => x.provider === 'FCM')) {
    try {
      await messaging.send(buildFcmMessage(d.token, push), true);
      report.check('fcm', `dry-run accepted for device ${mask(d.token)}`, true);
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'unknown';
      report.check('fcm', `dry-run accepted for device ${mask(d.token)}`, false, code);
    }
  }
  if (!has('no-deliver')) {
    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const sender = FcmNotificationSender.fromApp(app, logger);
    const results = await sender.send(
      devices.map((d) => ({ token: d.token, provider: d.provider, platform: d.platform })),
      push,
    );
    for (const r of results) {
      report.check(
        'fcm',
        `delivered to FCM for device ${mask(r.token)}`,
        r.success,
        r.error ?? 'accepted',
      );
    }
    report.note(
      `Sent event ${e.id} (${e.ticker} ${e.signalType} ${e.timeframe}). On the phone: confirm it appears, then tap it and confirm the "Signal explained" screen for this event opens.`,
    );
  }
  const bogus = await FcmNotificationSender.fromApp(app, {
    info: () => {},
    warn: () => {},
    error: () => {},
  }).send(
    [{ token: 'not-a-real-registration-token-000000', provider: 'FCM', platform: 'android' }],
    push,
  );
  report.check(
    'fcm',
    'a malformed token is classified as permanently invalid (device would be deleted)',
    bogus[0]?.success === false && (bogus[0].invalidToken === true || bogus[0].retryable === false),
    `code=${bogus[0]?.error} invalidToken=${bogus[0]?.invalidToken} retryable=${bogus[0]?.retryable}`,
  );
  return finish(prisma);
}

async function finish(prisma: { $disconnect(): Promise<void> }) {
  report.write('push');
  await prisma.$disconnect();
  process.exit(report.failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
