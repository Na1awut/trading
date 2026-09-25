import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Metrics } from '@signals/config';
import { addToWatchlist, createPrismaClient, findOrCreateUser } from '@signals/db';
import { resetDatabase, testDatabaseUrl } from '@signals/db/testing';
import { MOCK_ASSETS, ScriptedMarketDataProvider } from '@signals/market-data';
import { RecordingNotificationSender } from '@signals/notifications';
import { runEvaluationCycle } from '../src/evaluation-cycle';
import { WorkerHealth, startHealthServer } from '../src/health';
import { countPendingNotifications, runNotificationSweep } from '../src/notifications/delivery';
import { buildEmaBullishCrossScenario } from '../src/scenarios';

const prisma = createPrismaClient(testDatabaseUrl('worker_test'));
const silent = { info() {}, warn() {}, error() {} };
const NOW = Date.UTC(2026, 8, 25, 14, 37, 30);

afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));

async function setup() {
  const u = await findOrCreateUser(prisma, {
    firebaseUid: 'dev:m@example.com',
    email: 'm@example.com',
  });
  await addToWatchlist(prisma, {
    userId: u.id,
    asset: MOCK_ASSETS.find((a) => a.symbol === 'NVDA')!,
    timeframe: '5m',
  });
  await prisma.signalSubscription.updateMany({
    where: { userId: u.id, signalDefinition: { NOT: { name: 'EMA 9/21 Bullish Cross' } } },
    data: { enabled: false },
  });
  await prisma.device.create({
    data: { userId: u.id, token: 'metrics-device', platform: 'android' },
  });
}

describe('worker metrics', () => {
  it('records cycles, pairs, store hits/misses, signals, sends, retries and failures', async () => {
    await setup();
    const metrics = new Metrics();
    const notifier = new RecordingNotificationSender();
    notifier.transientFailures.add('metrics-device');
    const provider = new ScriptedMarketDataProvider(() => NOW).setCandles(
      'NVDA',
      '5m',
      buildEmaBullishCrossScenario({ now: NOW, timeframe: '5m' }),
    );
    const deps = {
      prisma,
      marketData: provider,
      notifier,
      logger: silent,
      metrics,
      now: () => NOW,
    };

    await runEvaluationCycle(deps); // cross -> event -> send fails (transient) -> retry scheduled
    await runEvaluationCycle(deps); // same candle -> pair skipped
    expect(await countPendingNotifications(prisma)).toBe(1);
    notifier.transientFailures.clear();
    await runNotificationSweep({ prisma, notifier, logger: silent, metrics }, NOW + 31_000); // retry succeeds
    expect(await countPendingNotifications(prisma)).toBe(0);

    const c = metrics.snapshot().counters;
    expect(c).toMatchObject({
      worker_cycles_total: 2,
      worker_pairs_evaluated_total: 1,
      'worker_pairs_skipped_total{reason="up_to_date"}': 1,
      candle_store_misses_total: 1,
      worker_subscriptions_evaluated_total: 1,
      signals_triggered_total: 1,
      signal_events_created_total: 1,
      notifications_sent_total: 1,
      notification_retries_total: 1,
      'notification_failures_total{permanent="false"}': 1,
      'notification_deliveries_total{outcome="RETRY_SCHEDULED"}': 1,
      'notification_deliveries_total{outcome="SENT"}': 1,
    });
    expect(metrics.snapshot().timings.worker_cycle_duration_ms!.count).toBe(2);
  });

  it('serves /metrics (JSON and Prometheus) on the internal health port', async () => {
    const metrics = new Metrics();
    metrics.inc('worker_cycles_total', undefined, 3);
    const server = startHealthServer(new WorkerHealth(60_000), 0, metrics);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const json = (await (await fetch(`http://127.0.0.1:${port}/metrics`)).json()) as {
      counters: Record<string, number>;
    };
    expect(json.counters.worker_cycles_total).toBe(3);
    const text = await (await fetch(`http://127.0.0.1:${port}/metrics?format=prometheus`)).text();
    expect(text).toContain('signals_worker_cycles_total 3');
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    server.close();
  });
});
