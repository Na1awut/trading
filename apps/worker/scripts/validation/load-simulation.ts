/**
 * Load simulation (Phase 3, step 8): 100 / 500 / 1000 users watching AAPL, NVDA and SPY.
 *
 *   pnpm --filter @signals/worker validate:load [--users 100,500,1000] [--cycles 24]
 *        [--timeframe 5m] [--push-latency-ms 40]
 *
 * Runs the real evaluation cycle and delivery code against a real Postgres database
 * (LOAD_DATABASE_URL, default signals_load) with a simulated clock that advances one candle
 * per cycle. Measured per user count:
 *   - market-data requests (the provider is wrapped and counted),
 *   - SQL statements (Prisma query events),
 *   - evaluation (cycle) time, and the time spent in fan-out/delivery,
 *   - notification queue: events recorded, sent, and still pending after each cycle.
 *
 * ASSUMPTIONS, NOT MEASUREMENTS: market data is the deterministic mock provider (so vendor
 * latency is not included), and each push costs --push-latency-ms (default 40 ms, an
 * assumed FCM HTTP round trip) instead of calling FCM. Triggers come from normal evaluation
 * of the mock candles; none are forced.
 */
import { performance } from 'node:perf_hooks';
import { Metrics } from '@signals/config';
import { PrismaClient, addToWatchlist, findOrCreateUser } from '@signals/db';
import { resetDatabase } from '@signals/db/testing';
import { MockMarketDataProvider, type MarketDataProvider } from '@signals/market-data';
import type { NotificationSender, PushMessage, PushTarget } from '@signals/notifications';
import { TIMEFRAMES, candleOpenTime, timeframeToMs, type Timeframe } from '@signals/types';
import { createWorkerRuntime, runEvaluationCycle } from '../../src/evaluation-cycle';
import { countPendingNotifications } from '../../src/notifications/delivery';
import { Report } from './lib';

const argv = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const USER_COUNTS = argv('users', '100,500,1000').split(',').map(Number);
const CYCLES = Number(argv('cycles', '24'));
const TIMEFRAME = argv('timeframe', '5m') as Timeframe;
const PUSH_LATENCY_MS = Number(argv('push-latency-ms', '40'));
const SYMBOLS = ['AAPL', 'NVDA', 'SPY'];
const DB_URL =
  process.env.LOAD_DATABASE_URL ??
  'postgresql://signals:signals@localhost:5432/signals_load?schema=public';
if (!TIMEFRAMES.includes(TIMEFRAME)) throw new Error(`bad timeframe ${TIMEFRAME}`);

const report = new Report('Load simulation');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quietLogger = {
  info: () => {},
  warn: () => {},
  error: (obj: object, msg?: string) => console.error(msg, obj),
  debug: () => {},
};

class CountingProvider implements MarketDataProvider {
  readonly name = 'counting-mock';
  readonly delayed = false;
  readonly supportedTimeframes = TIMEFRAMES;
  calls = { candles: 0, quote: 0, other: 0 };
  constructor(private readonly inner: MarketDataProvider) {}
  getHistoricalCandles(...a: Parameters<MarketDataProvider['getHistoricalCandles']>) {
    this.calls.candles++;
    return this.inner.getHistoricalCandles(...a);
  }
  getQuote(s: string) {
    this.calls.quote++;
    return this.inner.getQuote(s);
  }
  searchSymbols(q: string, l?: number) {
    this.calls.other++;
    return this.inner.searchSymbols(q, l);
  }
  getAsset(s: string) {
    this.calls.other++;
    return this.inner.getAsset(s);
  }
}

class LatencySender implements NotificationSender {
  readonly name = 'simulated-fcm';
  sends = 0;
  messages = 0;
  async send(targets: PushTarget[], _message: PushMessage) {
    this.sends++;
    this.messages += targets.length;
    await sleep(PUSH_LATENCY_MS);
    return targets.map((t) => ({ token: t.token, success: true }));
  }
}

async function seed(prisma: PrismaClient, users: number, provider: MarketDataProvider) {
  await resetDatabase(prisma);
  const assets = await Promise.all(SYMBOLS.map((s) => provider.getAsset(s)));
  for (let u = 0; u < users; u++) {
    const user = await findOrCreateUser(prisma, {
      firebaseUid: `load:${u}`,
      email: `load-${u}@example.com`,
    });
    await prisma.device.create({
      data: { userId: user.id, token: `load-token-${u}-abcdefgh`, platform: 'android' },
    });
    for (const asset of assets) {
      await addToWatchlist(prisma, { userId: user.id, asset: asset!, timeframe: TIMEFRAME });
    }
  }
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

async function simulate(users: number) {
  const prisma = new PrismaClient({
    datasources: { db: { url: DB_URL } },
    log: [{ emit: 'event', level: 'query' }],
  });
  let queries = 0;
  prisma.$on('query', () => {
    queries++;
  });
  const tfMs = timeframeToMs(TIMEFRAME);
  // A weekday, 14:00 UTC, aligned to the timeframe; +10 s so the candle has closed.
  let clock = candleOpenTime(Date.UTC(2026, 8, 22, 14, 0), TIMEFRAME) + 10_000;
  const provider = new CountingProvider(new MockMarketDataProvider({ now: () => clock }));
  const sender = new LatencySender();
  const metrics = new Metrics();

  const seedStart = performance.now();
  await seed(prisma, users, provider);
  const seedMs = performance.now() - seedStart;
  const subs = await prisma.signalSubscription.count({ where: { enabled: true } });
  const defs = await prisma.signalDefinition.count({ where: { enabled: true } });
  provider.calls = { candles: 0, quote: 0, other: 0 };

  const runtime = createWorkerRuntime({
    candleLookback: 250,
    fetchConcurrency: 4,
    candleCloseGraceMs: 5000,
    maxCatchupCandles: 3,
    incompleteRefetchMs: 60_000,
    shardIndex: 0,
    shardCount: 1,
  });
  const rows: {
    cycle: number;
    ms: number;
    queries: number;
    candleCalls: number;
    triggered: number;
    events: number;
    sent: number;
    pending: number;
  }[] = [];
  for (let c = 0; c < CYCLES; c++) {
    const q0 = queries;
    const calls0 = provider.calls.candles;
    const t0 = performance.now();
    const s = await runEvaluationCycle({
      prisma,
      marketData: provider,
      notifier: sender,
      logger: quietLogger,
      now: () => clock,
      runtime,
      metrics,
      delivery: { maxAgeMs: 365 * 86_400_000 },
    });
    const ms = performance.now() - t0;
    rows.push({
      cycle: c,
      ms: Math.round(ms),
      queries: queries - q0,
      candleCalls: provider.calls.candles - calls0,
      triggered: s.triggered,
      events: s.eventsCreated,
      sent: s.notificationsSent,
      pending: await countPendingNotifications(prisma),
    });
    clock += tfMs;
  }
  const steady = rows.slice(1);
  const triggerRows = steady.filter((r) => r.triggered > 0);
  const quietRows = steady.filter((r) => r.triggered === 0);
  const events = rows.reduce((s, r) => s + r.events, 0);
  const result = {
    users,
    timeframe: TIMEFRAME,
    cycles: CYCLES,
    signalDefinitions: defs,
    subscriptions: subs,
    seedSeconds: +(seedMs / 1000).toFixed(1),
    marketDataCandleRequests: provider.calls.candles,
    marketDataRequestsPerCycleSteady: +(
      steady.reduce((s, r) => s + r.candleCalls, 0) / Math.max(1, steady.length)
    ).toFixed(2),
    firstCycle: rows[0],
    sqlPerQuietCycle: quietRows.length
      ? pct(
          quietRows.map((r) => r.queries),
          50,
        )
      : null,
    sqlPerTriggeringCycleMax: triggerRows.length
      ? Math.max(...triggerRows.map((r) => r.queries))
      : null,
    quietCycleMsP50: quietRows.length
      ? pct(
          quietRows.map((r) => r.ms),
          50,
        )
      : null,
    triggeringCycleMsMax: triggerRows.length ? Math.max(...triggerRows.map((r) => r.ms)) : null,
    triggers: rows.reduce((s, r) => s + r.triggered, 0),
    eventsCreated: events,
    notificationsSent: rows.reduce((s, r) => s + r.sent, 0),
    pushCalls: sender.sends,
    maxPendingAfterCycle: Math.max(...rows.map((r) => r.pending)),
    msPerEventInTriggeringCycles: triggerRows.length
      ? +(
          triggerRows.reduce((s, r) => s + r.ms, 0) /
          Math.max(
            1,
            triggerRows.reduce((s, r) => s + r.events, 0),
          )
        ).toFixed(1)
      : null,
    rows,
  };
  await prisma.$disconnect();
  return result;
}

async function main() {
  const results = [];
  for (const n of USER_COUNTS) {
    console.info(`\n=== ${n} users ===`);
    const r = await simulate(n);
    results.push(r);
    const { rows: _rows, ...summary } = r;
    console.info(JSON.stringify(summary, null, 2));
    const budget = timeframeToMs(TIMEFRAME);
    report.check(
      `${n} users`,
      'market-data requests do not grow with users (one per pair per closed candle)',
      r.marketDataRequestsPerCycleSteady <= SYMBOLS.length,
      `${r.marketDataRequestsPerCycleSteady} candle requests/cycle for ${SYMBOLS.length} pairs; ${r.subscriptions} subscriptions`,
    );
    report.check(
      `${n} users`,
      `worst cycle finishes within one ${TIMEFRAME} candle`,
      (r.triggeringCycleMsMax ?? r.quietCycleMsP50 ?? 0) < budget,
      `quiet p50=${r.quietCycleMsP50} ms; worst triggering=${r.triggeringCycleMsMax} ms; ${r.triggers} triggers -> ${r.eventsCreated} events`,
    );
    report.check(
      `${n} users`,
      'notification queue drains every cycle',
      r.maxPendingAfterCycle === 0,
      `max pending after a cycle=${r.maxPendingAfterCycle}; sent=${r.notificationsSent}`,
    );
  }
  report.note(
    `Mock market data (no vendor latency) and a simulated push cost of ${PUSH_LATENCY_MS} ms per send. Timing is from this container, not production hardware.`,
  );
  report.write('load', { results });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
