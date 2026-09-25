/**
 * Database growth audit and retention verification (Phase 3, step 9).
 *
 *   pnpm --filter @signals/worker validate:db-growth
 *
 * Uses a real Postgres database (GROWTH_DATABASE_URL, default signals_growth):
 *  1. Creates real rows through the normal code paths: users/devices/subscriptions via the
 *     db services, SignalEvents (with full evidence JSON) via the real evaluation cycle over
 *     mock candles, and MarketCandle rows via saveCandles.
 *  2. Measures on-disk bytes per row (heap + indexes + TOAST) with pg_total_relation_size.
 *  3. Projects per-day and per-month growth for stated scenarios.
 *  4. Verifies candle retention: old rows deleted, the lookback window kept, re-run is a no-op.
 *
 * The trigger rate used for SignalEvent projections comes from MOCK candles and is an
 * assumption, not a market measurement; the report says so.
 */
import { PrismaClient, addToWatchlist, findOrCreateUser, saveCandles } from '@signals/db';
import { resetDatabase } from '@signals/db/testing';
import { MockMarketDataProvider } from '@signals/market-data';
import type { NotificationSender, PushTarget } from '@signals/notifications';
import { candleOpenTime, timeframeToMs, type Timeframe } from '@signals/types';
import { createWorkerRuntime, runEvaluationCycle } from '../../src/evaluation-cycle';
import { runCandleRetention } from '../../src/retention';
import { Report } from './lib';

const DB_URL =
  process.env.GROWTH_DATABASE_URL ??
  'postgresql://signals:signals@localhost:5432/signals_growth?schema=public';
const USERS = 50;
const SYMBOLS = ['AAPL', 'NVDA', 'SPY'];
const EVAL_CYCLES = 180; // 3 simulated hours of 1m candles
const DAY = 86_400_000;

const report = new Report('Database growth audit and retention verification');
const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
const quiet = { info: () => {}, warn: () => {}, error: console.error, debug: () => {} };
const instant: NotificationSender = {
  name: 'instant',
  send: async (targets: PushTarget[]) => targets.map((t) => ({ token: t.token, success: true })),
};

function syntheticCandles(timeframe: Timeframe, count: number, endMs: number) {
  const step = timeframeToMs(timeframe);
  const last = candleOpenTime(endMs, timeframe) - step;
  return Array.from({ length: count }, (_, i) => {
    const p = 100 + Math.sin(i / 17) * 5 + i * 0.001;
    return {
      time: last - (count - 1 - i) * step,
      open: p,
      high: p + 0.5,
      low: p - 0.5,
      close: p + 0.1,
      volume: 1_000_000 + (i % 97) * 1000,
    };
  });
}

async function tableStats() {
  await prisma.$executeRawUnsafe('VACUUM ANALYZE');
  const rows = await prisma.$queryRaw<
    { table: string; rows: bigint; total: bigint; heap: bigint; indexes: bigint }[]
  >`
    SELECT c.relname AS "table",
           (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I', c.relname), false, true, '')))[1]::text::bigint AS rows,
           pg_total_relation_size(c.oid) AS total,
           pg_relation_size(c.oid) AS heap,
           pg_indexes_size(c.oid) AS indexes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
    ORDER BY pg_total_relation_size(c.oid) DESC`;
  return rows.map((r) => ({
    table: r.table,
    rows: Number(r.rows),
    totalBytes: Number(r.total),
    heapBytes: Number(r.heap),
    indexBytes: Number(r.indexes),
    bytesPerRow: Number(r.rows) > 0 ? Math.round(Number(r.total) / Number(r.rows)) : null,
  }));
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  await resetDatabase(prisma);
  const mock = new MockMarketDataProvider();
  // 1. Users, devices, watchlists, preset subscriptions (normal service code).
  for (let u = 0; u < USERS; u++) {
    const user = await findOrCreateUser(prisma, {
      firebaseUid: `growth:${u}`,
      email: `growth-${u}@example.com`,
    });
    await prisma.device.create({
      data: {
        userId: user.id,
        // Real FCM registration tokens are ~163 characters.
        token: `growth${u}:${'x'.repeat(150)}`,
        platform: 'android',
      },
    });
    for (const s of SYMBOLS) {
      await addToWatchlist(prisma, {
        userId: user.id,
        asset: (await mock.getAsset(s))!,
        timeframe: '1m',
      });
    }
  }

  // 2. Real SignalEvents through the evaluation cycle (mock candles, natural triggers).
  let clock = candleOpenTime(Date.UTC(2026, 8, 22, 14, 0), '1m') + 10_000;
  const provider = new MockMarketDataProvider({ now: () => clock });
  const runtime = createWorkerRuntime({
    candleLookback: 250,
    fetchConcurrency: 4,
    candleCloseGraceMs: 5000,
    maxCatchupCandles: 3,
    incompleteRefetchMs: 60_000,
    shardIndex: 0,
    shardCount: 1,
  });
  let triggers = 0;
  let evaluations = 0;
  for (let c = 0; c < EVAL_CYCLES; c++) {
    const s = await runEvaluationCycle({
      prisma,
      marketData: provider,
      notifier: instant,
      logger: quiet,
      now: () => clock,
      runtime,
      delivery: { maxAgeMs: 365 * DAY },
    });
    if (c > 0) {
      triggers += s.triggered;
      evaluations += s.evaluated;
    }
    clock += 60_000;
  }
  const definitions = await prisma.signalDefinition.count({ where: { enabled: true } });
  const subsPerUser = (await prisma.signalSubscription.count({ where: { enabled: true } })) / USERS;
  const triggerRatePerEvaluation = evaluations ? triggers / evaluations : 0;

  // 3. Candle history for every timeframe (enough rows for a stable bytes/row figure).
  const now = Date.now();
  for (const s of SYMBOLS) {
    await saveCandles(prisma, s, '1m', syntheticCandles('1m', 20_000, now), 'growth');
    await saveCandles(prisma, s, '5m', syntheticCandles('5m', 5_000, now), 'growth');
    await saveCandles(prisma, s, '1d', syntheticCandles('1d', 1_000, now), 'growth');
  }

  const stats = await tableStats();
  const per = (t: string) => stats.find((s) => s.table === t)?.bytesPerRow ?? 0;
  for (const s of stats.filter((x) => x.rows > 0)) {
    report.note(
      `${s.table}: ${s.rows} rows, ${mb(s.totalBytes)} total (heap ${mb(s.heapBytes)}, indexes ${mb(s.indexBytes)}), ${s.bytesPerRow} B/row`,
    );
  }

  // 4. Projections. Bars/day per (symbol, timeframe): US regular session vs 24/7 crypto.
  const barsPerDay: Record<Timeframe, { equity: number; crypto: number }> = {
    '1m': { equity: 390, crypto: 1440 },
    '5m': { equity: 78, crypto: 288 },
    '15m': { equity: 26, crypto: 96 },
    '1h': { equity: 7, crypto: 24 },
    '1d': { equity: 1, crypto: 1 },
  };
  const retentionDays: Record<Timeframe, number> = {
    '1m': 7,
    '5m': 60,
    '15m': 180,
    '1h': 730,
    '1d': 0,
  };
  const candleRow = per('MarketCandle');
  const eventRow = per('SignalEvent');
  const projections = [
    {
      name: '1,000 users, AAPL/NVDA/SPY, all 5 timeframes',
      users: 1000,
      equityPairs: 15,
      cryptoPairs: 0,
    },
    {
      name: '10,000 users, 200 equity + 10 crypto tickers, all 5 timeframes',
      users: 10_000,
      equityPairs: 1000,
      cryptoPairs: 50,
    },
  ].map((p) => {
    let candleRowsPerDay = 0;
    let steadyCandleRows = 0;
    for (const tf of Object.keys(barsPerDay) as Timeframe[]) {
      const equityDay = (p.equityPairs / 5) * barsPerDay[tf].equity;
      const cryptoDay = (p.cryptoPairs / 5) * barsPerDay[tf].crypto;
      candleRowsPerDay += equityDay + cryptoDay;
      // Rows held once retention reaches steady state (equities trade 5 of 7 days). 1d is
      // kept forever (policy 0) and is excluded here; it adds one row per pair per day.
      if (retentionDays[tf]) {
        steadyCandleRows += retentionDays[tf] * (equityDay * (5 / 7) + cryptoDay);
      }
    }
    // Events/day: each user's subscriptions evaluated once per closed candle of their timeframe.
    // Worst case uses 1m for everyone; typical uses 5m. Rate comes from mock candles.
    const eventsPerDay5m =
      p.users * subsPerUser * barsPerDay['5m'].equity * triggerRatePerEvaluation;
    const eventsPerDay1m =
      p.users * subsPerUser * barsPerDay['1m'].equity * triggerRatePerEvaluation;
    return {
      ...p,
      marketCandleRowsPerDay: Math.round(candleRowsPerDay),
      marketCandleBytesPerDay: mb(candleRowsPerDay * candleRow),
      marketCandleBytesPerMonth: mb(candleRowsPerDay * candleRow * 30),
      marketCandleSteadyStateExcluding1d: mb(steadyCandleRows * candleRow),
      signalEventsPerDay5m: Math.round(eventsPerDay5m),
      signalEventBytesPerMonth5m: mb(eventsPerDay5m * eventRow * 30),
      signalEventsPerDay1m: Math.round(eventsPerDay1m),
      signalEventBytesPerMonth1m: mb(eventsPerDay1m * eventRow * 30),
      devices: p.users * 1.3,
      devicesBytes: mb(p.users * 1.3 * per('Device')),
      subscriptions: Math.round(p.users * subsPerUser),
      subscriptionsBytes: mb(p.users * subsPerUser * per('SignalSubscription')),
    };
  });
  for (const p of projections) console.info(JSON.stringify(p, null, 2));
  report.note(
    `Trigger rate ${(triggerRatePerEvaluation * 100).toFixed(3)}% per definition evaluation (${triggers}/${evaluations}) is from MOCK candles; real markets will differ.`,
  );
  report.note(
    `Preset subscriptions per watched ticker: ${(subsPerUser / SYMBOLS.length).toFixed(1)} enabled; ${definitions} shared definitions for ${USERS} users (definitions do not grow with users).`,
  );

  // 5. Retention verification on a clean candle table.
  await prisma.$executeRaw`DELETE FROM "MarketCandle"`;
  const tNow = Date.now();
  const lookback = 250;
  // 10 days of 1m candles (24/7 to be conservative), policy keeps 7.
  await saveCandles(prisma, 'AAPL', '1m', syntheticCandles('1m', 14_400, tNow), 'growth');
  await saveCandles(prisma, 'AAPL', '1d', syntheticCandles('1d', 2_000, tNow), 'growth');
  const before = await prisma.marketCandle.count({ where: { symbol: 'AAPL', timeframe: '1m' } });
  const policy = { '1m': 7, '5m': 60, '15m': 180, '1h': 730, '1d': 0 } as const;
  const t0 = Date.now();
  const r1 = await runCandleRetention(prisma, policy, tNow);
  const ms = Date.now() - t0;
  const after = await prisma.marketCandle.count({ where: { symbol: 'AAPL', timeframe: '1m' } });
  const oldest = await prisma.marketCandle.findFirst({
    where: { symbol: 'AAPL', timeframe: '1m' },
    orderBy: { time: 'asc' },
  });
  const daily = await prisma.marketCandle.count({ where: { symbol: 'AAPL', timeframe: '1d' } });
  const r2 = await runCandleRetention(prisma, policy, tNow);
  report.check(
    'retention',
    '1m rows older than 7 days are deleted',
    (oldest?.time.getTime() ?? 0) >= tNow - 7 * DAY && before - after === r1.deleted['1m'],
    `${before} -> ${after} rows; deleted ${r1.deleted['1m']} in ${ms} ms; oldest kept ${oldest?.time.toISOString()}`,
  );
  report.check(
    'retention',
    'the evaluation lookback window survives retention',
    after >= lookback,
    `${after} >= ${lookback}`,
  );
  report.check('retention', '1d kept forever (policy 0)', daily === 2000, `${daily} daily rows`);
  report.check(
    'retention',
    're-running retention is a no-op',
    Object.values(r2.deleted).every((n) => n === 0),
    JSON.stringify(r2.deleted),
  );
  report.note(
    'SignalEvent, Device and SignalSubscription have no automatic retention. SignalEvent grows with users x triggers; see the projections.',
  );
  report.write('db-growth', { stats, projections, triggerRatePerEvaluation, subsPerUser });
  await prisma.$disconnect();
  process.exit(report.failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
