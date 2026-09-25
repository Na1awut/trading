import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToWatchlist,
  createPrismaClient,
  findOrCreateUser,
  listSignalEvents,
  setTickerAlerts,
  updateSettings,
} from '@signals/db';
import { resetDatabase, testDatabaseUrl } from '@signals/db/testing';
import {
  MOCK_ASSETS,
  MockMarketDataProvider,
  ScriptedMarketDataProvider,
} from '@signals/market-data';
import { RecordingNotificationSender } from '@signals/notifications';
import { SignalEvidenceSchema, timeframeToMs, type Candle } from '@signals/types';
import { runEvaluationCycle } from '../src/evaluation-cycle';
import { buildEmaBullishCrossScenario } from '../src/scenarios';

const prisma = createPrismaClient(testDatabaseUrl('worker_test'));
const silent = { info() {}, warn() {}, error() {} };
const NOW = Date.UTC(2026, 8, 25, 14, 37, 30);
const TF = '5m' as const;
const NVDA = MOCK_ASSETS.find((a) => a.symbol === 'NVDA')!;

let notifier: RecordingNotificationSender;

afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  await resetDatabase(prisma);
  notifier = new RecordingNotificationSender();
});

async function user(email: string, { device = true } = {}) {
  const u = await findOrCreateUser(prisma, { firebaseUid: `dev:${email}`, email });
  await addToWatchlist(prisma, { userId: u.id, asset: NVDA, timeframe: TF });
  // First deliverable: only the EMA 9/21 bullish preset, so assertions are exact.
  await prisma.signalSubscription.updateMany({
    where: {
      userId: u.id,
      signalDefinition: {
        NOT: { signalType: 'EMA_BULLISH_CROSS', name: 'EMA 9/21 Bullish Cross' },
      },
    },
    data: { enabled: false },
  });
  if (device) {
    await prisma.device.create({
      data: { userId: u.id, token: `token-${email}`, platform: 'android' },
    });
  }
  return u;
}

function scripted(candles: Candle[]) {
  return new ScriptedMarketDataProvider(() => NOW).setCandles('NVDA', TF, candles);
}

const cycle = (marketData: ScriptedMarketDataProvider | MockMarketDataProvider, now = NOW) =>
  runEvaluationCycle({ prisma, marketData, notifier, logger: silent, now: () => now });

describe('vertical slice: add NVDA -> EMA 9/21 bullish cross -> event -> notification -> history', () => {
  it('creates one explained event and one notification for the crossover candle', async () => {
    const alice = await user('alice@example.com');
    const candles = buildEmaBullishCrossScenario({ now: NOW, timeframe: TF });
    const crossCandle = candles.at(-2)!; // last COMPLETED candle

    const summary = await cycle(scripted(candles));
    expect(summary).toMatchObject({
      pairs: 1,
      evaluated: 1,
      triggered: 1,
      eventsCreated: 1,
      notificationsSent: 1,
      errors: 0,
    });

    const [event] = await listSignalEvents(prisma, alice.id);
    expect(event).toMatchObject({
      ticker: 'NVDA',
      signalType: 'EMA_BULLISH_CROSS',
      category: 'MOVING_AVERAGE',
      timeframe: '5m',
      price: crossCandle.close,
      candleTime: new Date(crossCandle.time).toISOString(),
      message: `EMA 9 crossed above EMA 21 at $${crossCandle.close.toFixed(2)}`,
      deliveryStatus: 'SENT',
    });
    expect(event!.values.ema9!).toBeGreaterThan(event!.values.ema21!);
    expect(event!.values).toHaveProperty('rsi14');
    expect(event!.values).toHaveProperty('volumeRatio');

    // Structured evidence: the transition itself, not just a sentence.
    const evidence = SignalEvidenceSchema.parse(event!.evidence);
    expect(evidence).toMatchObject({
      type: 'EMA_BULLISH_CROSS',
      symbol: 'NVDA',
      timeframe: '5m',
      condition: { previous: false, current: true },
      candle: { close: crossCandle.close, timestamp: new Date(crossCandle.time).toISOString() },
    });
    expect(evidence.previous.ema9!).toBeLessThanOrEqual(evidence.previous.ema21!);
    expect(evidence.current.ema9!).toBeGreaterThan(evidence.current.ema21!);

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.message).toEqual({
      title: 'NVDA — EMA Bullish Cross',
      body: `EMA 9 crossed above EMA 21 at $${crossCandle.close.toFixed(2)} (5m)`,
      data: {
        type: 'signal',
        eventId: event!.id,
        ticker: 'NVDA',
        url: 'stocksignals://asset/NVDA',
      },
    });

    const state = await prisma.signalState.findFirstOrThrow();
    expect(state.lastCandleTime.getTime()).toBe(crossCandle.time);
    expect(state.lastActive).toBe(true);

    // completed candles were ingested; the in-progress one was not
    expect(await prisma.marketCandle.count()).toBe(candles.length - 1);
  });

  it('ignores a crossover that only exists in the in-progress candle', async () => {
    await user('alice@example.com');
    const candles = buildEmaBullishCrossScenario({ now: NOW, timeframe: TF });
    // Shift time so the cross candle is the one still in progress.
    const shifted = candles.slice(0, -1).map((c) => ({ ...c, time: c.time + timeframeToMs(TF) }));
    const summary = await cycle(scripted(shifted));
    expect(summary.triggered).toBe(0);
    expect(notifier.sent).toHaveLength(0);
  });
});

describe('duplicate alert prevention', () => {
  it('does not fire again when polling the same candle', async () => {
    await user('alice@example.com');
    const provider = scripted(buildEmaBullishCrossScenario({ now: NOW, timeframe: TF }));
    await cycle(provider);
    const second = await cycle(provider);
    expect(second).toMatchObject({ evaluated: 0, skippedUpToDate: 1, eventsCreated: 0 });
    expect(await prisma.signalEvent.count()).toBe(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it('does not fire on the next candle while EMA 9 stays above EMA 21', async () => {
    await user('alice@example.com');
    const candles = buildEmaBullishCrossScenario({ now: NOW, timeframe: TF });
    await cycle(scripted(candles));
    const next = NOW + timeframeToMs(TF);
    const last = candles.at(-2)!;
    const continued = [
      ...candles.slice(0, -1),
      {
        ...last,
        time: last.time + timeframeToMs(TF),
        open: last.close,
        close: last.close + 0.6,
        high: last.close + 0.7,
      },
    ];
    const summary = await runEvaluationCycle({
      prisma,
      marketData: new ScriptedMarketDataProvider(() => next).setCandles('NVDA', TF, continued),
      notifier,
      logger: silent,
      now: () => next,
    });
    expect(summary).toMatchObject({ evaluated: 1, triggered: 0 });
    expect(await prisma.signalEvent.count()).toBe(1);
  });

  it('database uniqueness blocks duplicates even if transition state is lost', async () => {
    await user('alice@example.com');
    const provider = scripted(buildEmaBullishCrossScenario({ now: NOW, timeframe: TF }));
    await cycle(provider);
    await prisma.signalState.deleteMany(); // simulate lost state / crash before state write
    const again = await cycle(provider);
    expect(again).toMatchObject({
      triggered: 1,
      eventsCreated: 0,
      duplicatesSkipped: 1,
      notificationsSent: 0,
    });
    expect(await prisma.signalEvent.count()).toBe(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it('concurrent workers produce exactly one event and one notification', async () => {
    await user('alice@example.com');
    const provider = scripted(buildEmaBullishCrossScenario({ now: NOW, timeframe: TF }));
    const results = await Promise.all([cycle(provider), cycle(provider), cycle(provider)]);
    expect(results.reduce((n, r) => n + r.eventsCreated, 0)).toBe(1);
    expect(await prisma.signalEvent.count()).toBe(1);
    expect(notifier.sent).toHaveLength(1);
  });
});

describe('fan-out and notification settings', () => {
  it('evaluates a shared preset once and notifies every subscriber', async () => {
    await user('alice@example.com');
    await user('bob@example.com');
    const summary = await cycle(
      scripted(buildEmaBullishCrossScenario({ now: NOW, timeframe: TF })),
    );
    expect(summary).toMatchObject({
      evaluated: 1,
      triggered: 1,
      eventsCreated: 2,
      notificationsSent: 2,
    });
    expect(notifier.sent.map((s) => s.targets[0]!.token).sort()).toEqual([
      'token-alice@example.com',
      'token-bob@example.com',
    ]);
  });

  it('records but suppresses alerts when disabled globally, per ticker or per category', async () => {
    const a = await user('global@example.com');
    const b = await user('ticker@example.com');
    const c = await user('category@example.com');
    await updateSettings(prisma, a.id, { alertsEnabled: false });
    await setTickerAlerts(prisma, b.id, 'NVDA', false);
    await updateSettings(prisma, c.id, { disabledCategories: ['MOVING_AVERAGE'] });

    await cycle(scripted(buildEmaBullishCrossScenario({ now: NOW, timeframe: TF })));
    const events = await prisma.signalEvent.findMany({
      include: { user: true },
      orderBy: { user: { email: 'asc' } },
    });
    expect(events.map((e) => [e.user.email, e.deliveryStatus, e.deliveryError])).toEqual([
      ['category@example.com', 'SUPPRESSED', 'MOVING_AVERAGE alerts disabled'],
      ['global@example.com', 'SUPPRESSED', 'alerts disabled globally'],
      ['ticker@example.com', 'SUPPRESSED', 'alerts disabled for NVDA'],
    ]);
    expect(notifier.sent).toHaveLength(0);
  });

  it('does not evaluate or record signals whose subscription is disabled', async () => {
    const a = await user('alice@example.com');
    await prisma.signalSubscription.updateMany({
      where: { userId: a.id },
      data: { enabled: false },
    });
    const summary = await cycle(
      scripted(buildEmaBullishCrossScenario({ now: NOW, timeframe: TF })),
    );
    expect(summary.pairs).toBe(0);
    expect(await prisma.signalEvent.count()).toBe(0);
  });

  it('marks NO_DEVICES when the user has no registered device', async () => {
    await user('alice@example.com', { device: false });
    await cycle(scripted(buildEmaBullishCrossScenario({ now: NOW, timeframe: TF })));
    expect((await prisma.signalEvent.findFirstOrThrow()).deliveryStatus).toBe('NO_DEVICES');
  });

  it('removes permanently invalid push tokens and marks the event FAILED', async () => {
    await user('alice@example.com');
    notifier.invalidTokens.add('token-alice@example.com');
    await cycle(scripted(buildEmaBullishCrossScenario({ now: NOW, timeframe: TF })));
    expect((await prisma.signalEvent.findFirstOrThrow()).deliveryStatus).toBe('FAILED');
    expect(await prisma.device.count()).toBe(0);
  });
});

describe('robustness', () => {
  it('a failing symbol does not stop other pairs', async () => {
    const alice = await user('alice@example.com');
    await addToWatchlist(prisma, {
      userId: alice.id,
      asset: MOCK_ASSETS.find((a) => a.symbol === 'AAPL')!,
      timeframe: TF,
    });
    const provider = scripted(buildEmaBullishCrossScenario({ now: NOW, timeframe: TF }));
    provider.getHistoricalCandles = async (symbol, tf, limit) => {
      if (symbol === 'AAPL') throw new Error('vendor timeout');
      return ScriptedMarketDataProvider.prototype.getHistoricalCandles.call(
        provider,
        symbol,
        tf,
        limit,
      );
    };
    const summary = await cycle(provider);
    expect(summary.errors).toBe(1);
    expect(summary.eventsCreated).toBe(1);
  });

  it('runs every enabled preset against deterministic mock data without errors', async () => {
    const alice = await user('alice@example.com');
    await prisma.signalSubscription.updateMany({
      where: { userId: alice.id },
      data: { enabled: true },
    });
    const summary = await cycle(new MockMarketDataProvider({ now: () => NOW }));
    expect(summary).toMatchObject({ pairs: 1, evaluated: 15, errors: 0 });
    expect(await prisma.marketCandle.count()).toBe(250); // full lookback of completed candles
  });
});
