import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addToWatchlist, createPrismaClient, findOrCreateUser } from '@signals/db';
import { resetDatabase, testDatabaseUrl } from '@signals/db/testing';
import { MOCK_ASSETS, ScriptedMarketDataProvider } from '@signals/market-data';
import { RecordingNotificationSender } from '@signals/notifications';
import { timeframeToMs, type Candle } from '@signals/types';
import {
  createWorkerRuntime,
  runEvaluationCycle,
  type WorkerRuntime,
  type WorkerSettings,
} from '../src/evaluation-cycle';
import { buildEmaBullishCrossScenario } from '../src/scenarios';

const prisma = createPrismaClient(testDatabaseUrl('worker_test'));
const silent = { info() {}, warn() {}, error() {} };
const NOW = Date.UTC(2026, 8, 25, 14, 37, 30);
const TF = '5m' as const;
const TF_MS = timeframeToMs(TF);
const asset = (s: string) => MOCK_ASSETS.find((a) => a.symbol === s)!;
/** One clock for the worker and the scripted vendor. */
const clock = { t: NOW };
const vendor = () => new ScriptedMarketDataProvider(() => clock.t);

afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));

async function user(email: string, symbols = ['NVDA'], { allPresets = false } = {}) {
  const u = await findOrCreateUser(prisma, { firebaseUid: `dev:${email}`, email });
  for (const s of symbols)
    await addToWatchlist(prisma, { userId: u.id, asset: asset(s), timeframe: TF });
  if (allPresets) {
    await prisma.signalSubscription.updateMany({
      where: { userId: u.id },
      data: { enabled: true },
    });
  } else {
    await prisma.signalSubscription.updateMany({
      where: { userId: u.id, signalDefinition: { NOT: { name: 'EMA 9/21 Bullish Cross' } } },
      data: { enabled: false },
    });
  }
  await prisma.device.create({
    data: { userId: u.id, token: `token-${email}`, platform: 'android' },
  });
  return u;
}

/** Continue a series with rising candles (keeps EMA 9 above EMA 21 after a bullish cross). */
function extend(candles: Candle[], n: number): Candle[] {
  const out = [...candles];
  for (let i = 0; i < n; i++) {
    const last = out.at(-1)!;
    out.push({
      ...last,
      time: last.time + TF_MS,
      open: last.close,
      close: last.close + 0.6,
      high: last.close + 0.7,
    });
  }
  return out;
}

function run(
  provider: ScriptedMarketDataProvider,
  now: number,
  opts: {
    settings?: Partial<WorkerSettings>;
    runtime?: WorkerRuntime;
    notifier?: RecordingNotificationSender;
  } = {},
) {
  clock.t = now;
  return runEvaluationCycle({
    prisma,
    marketData: provider,
    notifier: opts.notifier ?? new RecordingNotificationSender(),
    logger: silent,
    now: () => now,
    settings: opts.settings,
    runtime: opts.runtime,
  });
}

const scenario = () => buildEmaBullishCrossScenario({ now: NOW, timeframe: TF });

describe('grouped evaluation by (ticker, timeframe)', () => {
  it('fetches candles once per pair and computes indicators once for every subscription', async () => {
    await user('alice@example.com', ['NVDA'], { allPresets: true });
    await user('bob@example.com', ['NVDA'], { allPresets: true });
    const provider = vendor().setCandles('NVDA', TF, scenario());

    const summary = await run(provider, NOW);

    expect(provider.callsFor('getHistoricalCandles')).toHaveLength(1);
    expect(summary).toMatchObject({
      pairs: 1,
      pairsFetched: 1,
      evaluated: 15,
      subscriptionsEvaluated: 30,
    });
    // 15 presets x 2 users share a handful of series (EMA 9/20/21/50, RSI 14, MACD, volume)
    expect(summary.indicatorSeriesComputed).toBeLessThanOrEqual(8);
  });

  it('skips a pair entirely when its latest closed candle was already evaluated', async () => {
    await user('alice@example.com');
    const provider = vendor().setCandles('NVDA', TF, scenario());
    const runtime = createWorkerRuntime();
    await run(provider, NOW, { runtime });
    const again = await run(provider, NOW + 20_000, { runtime });
    expect(again).toMatchObject({ pairsSkippedUpToDate: 1, pairsFetched: 0, evaluated: 0 });
    expect(provider.callsFor('getHistoricalCandles')).toHaveLength(1);
  });

  it('downloads only the missing tail once full history is stored', async () => {
    await user('alice@example.com');
    const candles = extend(scenario(), 1); // one more candle closes 5 minutes later
    const provider = vendor().setCandles('NVDA', TF, candles);
    const settings = { candleLookback: 60 };
    await run(provider, NOW, { settings });
    await run(provider, NOW + TF_MS, { settings });
    const calls = provider.callsFor('getHistoricalCandles');
    expect(calls.map((c) => c.limit)).toEqual([61, 4]); // lookback+1 (in-progress bar), then 1 new + 3 overlap
  });

  it('reuses stored candles across worker instances without calling the vendor', async () => {
    await user('alice@example.com');
    const provider = vendor().setCandles('NVDA', TF, scenario());
    await run(provider, NOW, { settings: { candleLookback: 60 } });
    await prisma.signalState.deleteMany(); // a second instance with no evaluation state
    const summary = await run(provider, NOW, {
      settings: { candleLookback: 60 },
      runtime: createWorkerRuntime(),
    });
    expect(summary.evaluated).toBe(1);
    expect(provider.callsFor('getHistoricalCandles')).toHaveLength(1);
  });

  it('backs off when the vendor has not published the expected closed candle yet', async () => {
    await user('alice@example.com');
    const lagging = scenario().slice(0, -2); // latest closed (14:30) bar missing
    const provider = vendor().setCandles('NVDA', TF, lagging);
    const runtime = createWorkerRuntime({ incompleteRefetchMs: 60_000 });
    const first = await run(provider, NOW, { runtime });
    expect(first).toMatchObject({ pairsFetched: 1, stalePairs: 1 });
    const soon = await run(provider, NOW + 10_000, { runtime });
    expect(soon).toMatchObject({ pairsBackedOff: 1, pairsFetched: 0 });
    const later = await run(provider, NOW + 61_000, { runtime });
    expect(later.pairsFetched).toBe(1);
    expect(provider.callsFor('getHistoricalCandles')).toHaveLength(2);
  });

  it('splits pairs across shards without overlap', async () => {
    await user('alice@example.com', ['NVDA', 'AAPL', 'MSFT', 'SPY']);
    const provider = vendor();
    for (const s of ['NVDA', 'AAPL', 'MSFT', 'SPY']) provider.setCandles(s, TF, scenario());
    const s0 = await run(provider, NOW, { settings: { shardCount: 2, shardIndex: 0 } });
    const s1 = await run(provider, NOW, { settings: { shardCount: 2, shardIndex: 1 } });
    expect(s0.pairs + s1.pairs).toBe(4);
    const fetched = provider.callsFor('getHistoricalCandles').map((c) => c.symbol);
    expect(new Set(fetched).size).toBe(4);
  });
});

describe('strict candle completion', () => {
  it('waits for the grace period before evaluating a just-closed candle', async () => {
    await user('alice@example.com');
    const boundary = Date.UTC(2026, 8, 25, 14, 40); // the 14:35 bar ends here
    const candles = extend(
      buildEmaBullishCrossScenario({ now: boundary - 1_000, timeframe: TF }),
      1,
    );
    const provider = vendor().setCandles('NVDA', TF, candles);
    const settings = { candleCloseGraceMs: 5_000 };

    await run(provider, boundary + 3_000, { settings }); // within grace: 14:35 bar not closed yet
    let state = await prisma.signalState.findFirstOrThrow();
    expect(state.lastCandleTime.toISOString()).toBe('2026-09-25T14:30:00.000Z');

    await run(provider, boundary + 6_000, { settings });
    state = await prisma.signalState.findFirstOrThrow();
    expect(state.lastCandleTime.toISOString()).toBe('2026-09-25T14:35:00.000Z');
  });

  it('catches up on missed candles in order so a crossover is not lost', async () => {
    await user('alice@example.com');
    const base = scenario();
    const crossTime = base.at(-2)!.time;
    const candles = extend(base.slice(0, -1), 2);
    const provider = vendor().setCandles('NVDA', TF, candles);
    const notifier = new RecordingNotificationSender();

    // Worker last ran two candles before the cross...
    await run(provider, crossTime - TF_MS + 30_000, { notifier });
    expect(await prisma.signalEvent.count()).toBe(0);
    // ...then was delayed: three candles closed in the meantime (cross is the middle one).
    const summary = await run(provider, crossTime + 2 * TF_MS + 30_000, { notifier });
    expect(summary.evaluated).toBe(3);
    const event = await prisma.signalEvent.findFirstOrThrow();
    expect(event.candleTime.getTime()).toBe(crossTime);
    expect(notifier.sent).toHaveLength(1);
  });

  it('without catch-up the same delay would miss the crossover (documents the trade-off)', async () => {
    await user('alice@example.com');
    const base = scenario();
    const crossTime = base.at(-2)!.time;
    const provider = vendor().setCandles('NVDA', TF, extend(base.slice(0, -1), 2));
    await run(provider, crossTime - TF_MS + 30_000);
    await run(provider, crossTime + 2 * TF_MS + 30_000, { settings: { maxCatchupCandles: 1 } });
    expect(await prisma.signalEvent.count()).toBe(0);
  });

  it('bounds catch-up after a long outage (no flood of stale alerts)', async () => {
    await user('alice@example.com');
    const base = scenario();
    const provider = vendor().setCandles('NVDA', TF, extend(base.slice(0, -1), 20));
    await run(provider, base[40]!.time + TF_MS + 30_000);
    const summary = await run(provider, base.at(-2)!.time + 20 * TF_MS + 30_000, {
      settings: { maxCatchupCandles: 3 },
    });
    expect(summary.evaluated).toBe(3);
  });
});
