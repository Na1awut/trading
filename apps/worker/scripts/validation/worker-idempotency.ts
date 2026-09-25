/**
 * Worker idempotency soak (Phase 3, step 3), using the BUILT worker binary and Postgres.
 *
 *   pnpm build && pnpm --filter @signals/worker validate:idempotency [--minutes 6]
 *
 * MARKET DATA IS THE MOCK PROVIDER: this environment cannot reach a live vendor. The mock is
 * deterministic across processes (every worker sees identical candles), which is the worst
 * case for duplicates. Triggers are whatever the normal evaluation produces from those
 * candles; nothing is scripted to fire. This validates process concurrency, restart and
 * idempotency, NOT live market data.
 *
 * Phase 1 (unsharded, the misconfiguration worst case): workers A and B both evaluate every
 * pair. A is SIGKILLed mid-run and restarted. Phase 2: a repeat `--once` over the same state.
 * Phase 3 (sharded 0/2 and 1/2): each pair is evaluated by exactly one worker.
 *
 * Checks: no duplicate SignalEvents; every event is for a completed candle; every event
 * reaches a terminal notification state; each event is pushed once (a second push is only
 * allowed for events claimed by the killed worker, per the at-least-once design).
 */
import { createPrismaClient, addToWatchlist, findOrCreateUser } from '@signals/db';
import { resetDatabase } from '@signals/db/testing';
import { MockMarketDataProvider } from '@signals/market-data';
import { timeframeToMs } from '@signals/types';
import { Report, VALIDATION_DB_URL, WORKER_BIN, baseEnv, run, start, type Proc } from './lib';

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const MINUTES = arg('minutes', 6);
const USERS = arg('users', 5);
const SYMBOLS = ['AAPL', 'NVDA', 'SPY', 'MSFT', 'TSLA', 'AMD', 'META', 'BTC-USD'];

const report = new Report('Worker idempotency soak (mock market data)');
const prisma = createPrismaClient(VALIDATION_DB_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const workerEnv = (extra: Record<string, string> = {}) =>
  baseEnv({
    NODE_ENV: 'development',
    MARKET_DATA_PROVIDER: 'mock',
    NOTIFICATION_DRIVER: 'console',
    SIGNAL_POLL_INTERVAL_MS: '5000',
    SIGNAL_DEFAULT_TIMEFRAME: '1m',
    // Quiet cycles log their summary at debug; keep them so every cycle is counted.
    LOG_LEVEL: 'debug',
    ...extra,
  });

interface Summary {
  pairs: number;
  eventsCreated: number;
  duplicatesSkipped: number;
  triggered: number;
  errors: number;
}

function summaries(output: string): Summary[] {
  return output
    .split('\n')
    .filter((l) => l.includes('"evaluation cycle complete"'))
    .map((l) => JSON.parse(l) as Summary);
}

function pushedEventIds(output: string): string[] {
  return output
    .split('\n')
    .filter((l) => l.includes('[push:console]'))
    .map((l) => (JSON.parse(l) as { data?: { eventId?: string } }).data?.eventId)
    .filter((id): id is string => Boolean(id));
}

async function seed() {
  await resetDatabase(prisma);
  const mock = new MockMarketDataProvider();
  for (let u = 0; u < USERS; u++) {
    const user = await findOrCreateUser(prisma, {
      firebaseUid: `validation:idem-${u}`,
      email: `idem-${u}@example.com`,
    });
    await prisma.device.create({
      data: {
        userId: user.id,
        token: `validation-console-token-${u}-abcdef`,
        platform: 'android',
        provider: 'FCM',
      },
    });
    for (const symbol of SYMBOLS) {
      await addToWatchlist(prisma, {
        userId: user.id,
        asset: (await mock.getAsset(symbol))!,
        timeframe: '1m',
      });
    }
  }
  const subs = await prisma.signalSubscription.count({ where: { enabled: true } });
  const defs = await prisma.signalDefinition.count();
  report.note(
    `Seeded ${USERS} users x ${SYMBOLS.length} symbols (1m): ${defs} signal definitions, ${subs} enabled subscriptions.`,
  );
}

async function phaseConcurrent() {
  const totalMs = MINUTES * 60_000;
  const a1 = start(WORKER_BIN, [], workerEnv());
  const b = start(WORKER_BIN, [], workerEnv());
  const killAt = Math.floor(totalMs * 0.45);
  await sleep(killAt);
  a1.child.kill('SIGKILL');
  const killedAt = new Date();
  await a1.exited;
  // Events worker A had claimed but may not have finished pushing when it died.
  await sleep(15_000);
  const a2 = start(WORKER_BIN, [], workerEnv());
  await sleep(totalMs - killAt - 15_000);
  const procs: Proc[] = [a2, b];
  await Promise.all(procs.map((p) => p.stop()));
  // Let stale SENDING claims (if any) be swept by one last pass.
  const tail = await run(
    WORKER_BIN,
    ['--once'],
    workerEnv({ NOTIFICATION_SENDING_TIMEOUT_MS: '1000' }),
    60_000,
  );

  const outputs = { A1: a1.output(), A2: a2.output(), B: b.output(), tail: tail.output };
  const all = Object.values(outputs).join('\n');
  const cycles = Object.fromEntries(
    Object.entries(outputs).map(([k, v]) => [k, summaries(v)] as const),
  );
  const created = Object.values(cycles)
    .flat()
    .reduce((s, c) => s + c.eventsCreated, 0);
  const dupSkipped = Object.values(cycles)
    .flat()
    .reduce((s, c) => s + c.duplicatesSkipped, 0);
  const errors = Object.values(cycles)
    .flat()
    .reduce((s, c) => s + c.errors, 0);

  const events = await prisma.signalEvent.findMany({
    select: {
      id: true,
      userId: true,
      ticker: true,
      signalDefinitionId: true,
      timeframe: true,
      candleTime: true,
      triggeredAt: true,
      notificationStatus: true,
      notificationAttempts: true,
      lastNotificationAttemptAt: true,
    },
  });
  const dupGroups = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM (
      SELECT 1 FROM "SignalEvent"
      GROUP BY "userId", ticker, "signalDefinitionId", timeframe, "candleTime"
      HAVING count(*) > 1) d`;
  const byStatus = events.reduce<Record<string, number>>((m, e) => {
    m[e.notificationStatus] = (m[e.notificationStatus] ?? 0) + 1;
    return m;
  }, {});
  const incompleteCandle = events.filter(
    (e) => e.candleTime.getTime() + timeframeToMs(e.timeframe as '1m') > e.triggeredAt.getTime(),
  );

  report.note(
    `Phase 1 ran ${MINUTES} min: A1 ${cycles.A1!.length} cycles (SIGKILL at ${killedAt.toISOString()}), A2 ${cycles.A2!.length}, B ${cycles.B!.length}. Triggers came from normal evaluation of mock candles.`,
  );
  report.check(
    'concurrency',
    'signals were produced (the soak exercised event creation)',
    events.length > 0,
    `${events.length} events; created=${created}, duplicate inserts skipped=${dupSkipped}`,
  );
  report.check(
    'concurrency',
    'no duplicate SignalEvents with two unsharded workers + kill/restart',
    Number(dupGroups[0]!.n) === 0 && created === events.length,
    `duplicate groups=${dupGroups[0]!.n}; rows=${events.length}; creations reported=${created}`,
  );
  report.check(
    'concurrency',
    'the competing worker detected and skipped the duplicate inserts',
    dupSkipped > 0,
    `duplicatesSkipped=${dupSkipped}`,
  );
  report.check(
    'candles',
    'every event is for a completed candle (candleTime + interval <= triggeredAt)',
    incompleteCandle.length === 0,
    `${incompleteCandle.length} events on incomplete candles`,
  );
  report.check('cycles', 'no cycle errors', errors === 0, `errors=${errors}`);

  const pushed = pushedEventIds(all);
  const counts = new Map<string, number>();
  for (const id of pushed) counts.set(id, (counts.get(id) ?? 0) + 1);
  const multi = [...counts.entries()].filter(([, n]) => n > 1);
  const a1Pushed = new Set(pushedEventIds(outputs.A1));
  // A repeat push is expected only when A1 sent it, died before recording SENT, and the
  // stale SENDING claim was re-claimed (attempt > 1). Anything else is a real duplicate.
  const unexplained = multi.filter(([id]) => {
    const e = events.find((x) => x.id === id);
    return !(a1Pushed.has(id) && e && e.notificationAttempts > 1);
  });
  const nonTerminal = events.filter((e) => ['PENDING', 'SENDING'].includes(e.notificationStatus));
  report.check(
    'notifications',
    'every event reached a terminal notification state',
    nonTerminal.length === 0,
    `status counts ${JSON.stringify(byStatus)}`,
  );
  report.check(
    'notifications',
    'each event pushed exactly once (duplicates only where the killed worker was mid-send)',
    unexplained.length === 0,
    `${counts.size} events pushed, ${multi.length} pushed more than once, ${unexplained.length} unexplained`,
  );
  return events.length;
}

async function phaseRepeat(eventsBefore: number) {
  const r = await run(WORKER_BIN, ['--once'], workerEnv(), 60_000);
  const s = summaries(r.output);
  const after = await prisma.signalEvent.count();
  // A new 1m candle may have closed since phase 1; anything created must be for it.
  const newest = await prisma.signalEvent.findMany({
    where: { triggeredAt: { gte: new Date(Date.now() - 60_000) } },
    select: { candleTime: true },
  });
  report.check(
    'repeat',
    'a repeat run over the same state creates no events for already-evaluated candles',
    r.code === 0 &&
      after - eventsBefore === (s[0]?.eventsCreated ?? 0) &&
      newest.every((e) => Date.now() - e.candleTime.getTime() < 3 * 60_000),
    `exit=${r.code}; events ${eventsBefore} -> ${after}; created this run=${s[0]?.eventsCreated ?? 0}`,
  );
}

async function phaseSharded() {
  const env = (i: number) => workerEnv({ WORKER_SHARD_COUNT: '2', WORKER_SHARD_INDEX: String(i) });
  const [s0, s1] = await Promise.all([
    run(WORKER_BIN, ['--once'], env(0), 60_000),
    run(WORKER_BIN, ['--once'], env(1), 60_000),
  ]);
  const p0 = summaries(s0.output)[0]?.pairs ?? -1;
  const p1 = summaries(s1.output)[0]?.pairs ?? -1;
  const unsharded =
    summaries((await run(WORKER_BIN, ['--once'], workerEnv(), 60_000)).output)[0]?.pairs ?? -1;
  report.check(
    'sharding',
    'two shards partition the (ticker, timeframe) pairs with no overlap',
    p0 >= 0 && p1 >= 0 && p0 + p1 === unsharded && s0.code === 0 && s1.code === 0,
    `shard0=${p0}, shard1=${p1}, unsharded=${unsharded}`,
  );
}

async function main() {
  await seed();
  const n = await phaseConcurrent();
  await phaseRepeat(n);
  await phaseSharded();
  report.note(
    'Market data: MockMarketDataProvider (deterministic synthetic candles). This is not a live market-data validation.',
  );
  report.write('idempotency');
  await prisma.$disconnect();
  process.exit(report.failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
