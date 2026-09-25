import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addToWatchlist, createPrismaClient, findOrCreateUser, updateSettings } from '@signals/db';
import { resetDatabase, testDatabaseUrl } from '@signals/db/testing';
import { MOCK_ASSETS } from '@signals/market-data';
import { RecordingNotificationSender } from '@signals/notifications';
import {
  deliverEvent,
  runNotificationSweep,
  type DeliveryDeps,
} from '../src/notifications/delivery';
import { DEFAULT_DELIVERY_SETTINGS, retryDelayMs } from '../src/notifications/settings';

const prisma = createPrismaClient(testDatabaseUrl('worker_test'));
const silent = { info() {}, warn() {}, error() {} };
const T0 = Date.UTC(2026, 8, 25, 14, 37, 30);
const S = {
  ...DEFAULT_DELIVERY_SETTINGS,
  retryBaseMs: 30_000,
  maxAttempts: 5,
  sendingTimeoutMs: 120_000,
};

afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));

let notifier: RecordingNotificationSender;
const deps = (): DeliveryDeps => ({ prisma, notifier, logger: silent, delivery: S });

/** A user subscribed to NVDA EMA 9/21 bullish, with devices, and one recorded event. */
async function setup(opts: { devices?: string[]; event?: Record<string, unknown> } = {}) {
  notifier = new RecordingNotificationSender();
  const user = await findOrCreateUser(prisma, {
    firebaseUid: 'dev:a@example.com',
    email: 'a@example.com',
  });
  await addToWatchlist(prisma, {
    userId: user.id,
    asset: MOCK_ASSETS.find((a) => a.symbol === 'NVDA')!,
    timeframe: '5m',
  });
  for (const token of opts.devices ?? ['device-1']) {
    await prisma.device.create({ data: { userId: user.id, token, platform: 'android' } });
  }
  const def = await prisma.signalDefinition.findFirstOrThrow({
    where: { name: 'EMA 9/21 Bullish Cross' },
  });
  const event = await prisma.signalEvent.create({
    data: {
      userId: user.id,
      signalDefinitionId: def.id,
      ticker: 'NVDA',
      signalType: 'EMA_BULLISH_CROSS',
      category: 'MOVING_AVERAGE',
      name: def.name,
      timeframe: '5m',
      candleTime: new Date(T0 - 450_000),
      triggeredAt: new Date(T0),
      price: 182.3,
      values: {},
      message: 'EMA 9 crossed above EMA 21 at $182.30',
      notificationStatus: 'PENDING',
      nextNotificationAttemptAt: new Date(T0),
      ...opts.event,
    },
  });
  return { user, event };
}

const reload = (id: string) => prisma.signalEvent.findUniqueOrThrow({ where: { id } });

describe('crash safety', () => {
  it('worker crash after event insert: the sweep delivers the PENDING event', async () => {
    const { event } = await setup(); // inserted, never sent (process died)
    const sweep = await runNotificationSweep(deps(), T0 + 5_000);
    expect(sweep).toEqual({ candidates: 1, outcomes: { SENT: 1 } });
    expect(await reload(event.id)).toMatchObject({
      notificationStatus: 'SENT',
      notificationAttempts: 1,
    });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.message.data.eventId).toBe(event.id);
  });

  it('worker crash mid-send: a stale SENDING claim is re-claimed; a fresh one is left alone', async () => {
    const { event } = await setup({
      event: {
        notificationStatus: 'SENDING',
        notificationAttempts: 1,
        lastNotificationAttemptAt: new Date(T0),
      },
    });
    expect((await runNotificationSweep(deps(), T0 + 60_000)).candidates).toBe(0); // still within timeout
    const sweep = await runNotificationSweep(deps(), T0 + 121_000);
    expect(sweep.outcomes).toEqual({ SENT: 1 });
    expect(await reload(event.id)).toMatchObject({
      notificationStatus: 'SENT',
      notificationAttempts: 2,
    });
  });

  it('a timed-out claimer cannot overwrite a newer attempt', async () => {
    const { event } = await setup();
    // Worker A claims attempt 1 and hangs; worker B re-claims after the timeout (attempt 2).
    await prisma.signalEvent.update({
      where: { id: event.id },
      data: {
        notificationStatus: 'SENDING',
        notificationAttempts: 1,
        lastNotificationAttemptAt: new Date(T0),
      },
    });
    await deliverEvent(deps(), event.id, T0 + 200_000);
    // Worker A finally writes its (stale) result guarded by attempt 1 -> no effect.
    const stale = await prisma.signalEvent.updateMany({
      where: { id: event.id, notificationAttempts: 1, notificationStatus: 'SENDING' },
      data: { notificationStatus: 'FAILED' },
    });
    expect(stale.count).toBe(0);
    expect((await reload(event.id)).notificationStatus).toBe('SENT');
  });
});

describe('retries', () => {
  it('schedules a retry with back-off after a transient failure, then succeeds on the same event', async () => {
    const { event } = await setup();
    notifier.transientFailures.add('device-1');
    expect(await deliverEvent(deps(), event.id, T0)).toBe('RETRY_SCHEDULED');
    let e = await reload(event.id);
    expect(e).toMatchObject({
      notificationStatus: 'FAILED',
      notificationAttempts: 1,
      notificationError: 'messaging/unavailable',
    });
    expect(e.nextNotificationAttemptAt!.getTime()).toBe(T0 + 30_000);

    expect((await runNotificationSweep(deps(), T0 + 10_000)).candidates).toBe(0); // not due yet
    notifier.transientFailures.clear();
    expect((await runNotificationSweep(deps(), T0 + 30_000)).outcomes).toEqual({ SENT: 1 });
    e = await reload(event.id);
    expect(e).toMatchObject({
      notificationStatus: 'SENT',
      notificationAttempts: 2,
      notificationError: null,
    });
    expect(await prisma.signalEvent.count()).toBe(1); // resend of the same event, never a new one
    expect(new Set(notifier.sent.map((s) => s.message.data.eventId))).toEqual(new Set([event.id]));
  });

  it('gives up after maxAttempts with exponential back-off (permanent failure)', async () => {
    const { event } = await setup();
    notifier.transientFailures.add('device-1');
    let t = T0;
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      await runNotificationSweep(deps(), t);
      const e = await reload(event.id);
      if (!e.nextNotificationAttemptAt) break;
      delays.push(e.nextNotificationAttemptAt.getTime() - t);
      t = e.nextNotificationAttemptAt.getTime();
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000]);
    const e = await reload(event.id);
    expect(e).toMatchObject({
      notificationStatus: 'FAILED',
      notificationAttempts: 5,
      nextNotificationAttemptAt: null,
    });
    expect(e.notificationError).toMatch(/gave up after 5 attempts/);
    expect(notifier.sent).toHaveLength(5);
    expect((await runNotificationSweep(deps(), t + 86_400_000)).candidates).toBe(0);
  });

  it('does not retry non-retryable errors', async () => {
    const { event } = await setup();
    notifier.permanentFailures.add('device-1');
    expect(await deliverEvent(deps(), event.id, T0)).toBe('FAILED');
    expect(await reload(event.id)).toMatchObject({
      notificationAttempts: 1,
      nextNotificationAttemptAt: null,
    });
  });

  it('treats a sender exception (network outage) as retryable', async () => {
    const { event } = await setup();
    notifier.throwOnSend = new Error('ECONNRESET');
    expect(await deliverEvent(deps(), event.id, T0)).toBe('RETRY_SCHEDULED');
    expect((await reload(event.id)).notificationError).toBe('ECONNRESET');
  });

  it('back-off is capped', () => {
    expect(retryDelayMs(1, S)).toBe(30_000);
    expect(retryDelayMs(20, S)).toBe(S.retryMaxMs);
  });

  it('abandons notifications that are too old to be useful', async () => {
    const { event } = await setup({ event: { triggeredAt: new Date(T0 - 25 * 3_600_000) } });
    expect(await deliverEvent(deps(), event.id, T0)).toBe('EXPIRED');
    expect(await reload(event.id)).toMatchObject({
      notificationStatus: 'FAILED',
      notificationError: 'expired before delivery',
    });
    expect(notifier.sent).toHaveLength(0);
  });
});

describe('concurrency', () => {
  it('concurrent retry workers send exactly once', async () => {
    const { event } = await setup();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => runNotificationSweep(deps(), T0)),
    );
    const sent = results.reduce((n, r) => n + (r.outcomes.SENT ?? 0), 0);
    expect(sent).toBe(1);
    expect(notifier.sent).toHaveLength(1);
    expect(await reload(event.id)).toMatchObject({
      notificationStatus: 'SENT',
      notificationAttempts: 1,
    });
  });
});

describe('devices', () => {
  it('sends to every device and removes only the invalid token', async () => {
    const { event, user } = await setup({ devices: ['phone', 'tablet', 'old-phone'] });
    notifier.invalidTokens.add('old-phone');
    expect(await deliverEvent(deps(), event.id, T0)).toBe('SENT');
    expect(notifier.sent[0]!.targets.map((t) => t.token).sort()).toEqual([
      'old-phone',
      'phone',
      'tablet',
    ]);
    expect(
      (await prisma.device.findMany({ where: { userId: user.id } })).map((d) => d.token).sort(),
    ).toEqual(['phone', 'tablet']);
  });

  it('marks NO_DEVICES when every token is invalid (and deletes them)', async () => {
    const { event } = await setup({ devices: ['a', 'b'] });
    notifier.invalidTokens.add('a');
    notifier.invalidTokens.add('b');
    expect(await deliverEvent(deps(), event.id, T0)).toBe('NO_DEVICES');
    expect(await prisma.device.count()).toBe(0);
  });

  it('payload carries identifiers only (no user data)', async () => {
    const { event, user } = await setup();
    await deliverEvent(deps(), event.id, T0);
    const data = notifier.sent[0]!.message.data;
    expect(Object.keys(data).sort()).toEqual([
      'eventId',
      'signalType',
      'symbol',
      'timeframe',
      'type',
      'url',
    ]);
    expect(JSON.stringify(notifier.sent[0]!.message)).not.toContain(user.email!);
    expect(JSON.stringify(notifier.sent[0]!.message)).not.toContain(user.id);
  });
});

describe('preferences are checked at send time', () => {
  it('suppresses a pending retry after the user turns alerts off', async () => {
    const { event, user } = await setup();
    notifier.transientFailures.add('device-1');
    await deliverEvent(deps(), event.id, T0);
    await updateSettings(prisma, user.id, { alertsEnabled: false });
    expect((await runNotificationSweep(deps(), T0 + 30_000)).outcomes).toEqual({ SUPPRESSED: 1 });
    expect(await reload(event.id)).toMatchObject({
      notificationStatus: 'SUPPRESSED',
      notificationError: 'alerts disabled globally',
    });
  });
});
