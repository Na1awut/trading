import { pino } from 'pino';
import { LOG_REDACT_PATHS, loadConfig } from '@signals/config';
import { createPrismaClient } from '@signals/db';
import { createMarketDataProvider } from '@signals/market-data';
import { createNotificationSender } from '@signals/notifications';
import { strengthModelFromList } from '@signals/signal-engine';
import { createWorkerRuntime, runEvaluationCycle, type WorkerSettings } from './evaluation-cycle';
import { runNotificationSweep } from './notifications/delivery';
import type { DeliverySettings } from './notifications/settings';
import { WorkerHealth, startHealthServer } from './health';
import { runCandleRetention } from './retention';
import { startScheduler } from './scheduler';

async function main() {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, name: 'worker', redact: LOG_REDACT_PATHS });
  const prisma = createPrismaClient(config.DATABASE_URL);
  const marketData = createMarketDataProvider({
    provider: config.MARKET_DATA_PROVIDER,
    vendor: config.MARKET_DATA_VENDOR,
    apiKey: config.MARKET_DATA_API_KEY,
    baseUrl: config.MARKET_DATA_BASE_URL,
    allowCustomBaseUrl: config.MARKET_DATA_ALLOW_CUSTOM_BASE_URL,
    delayed: config.MARKET_DATA_DELAYED,
    timeoutMs: config.MARKET_DATA_TIMEOUT_MS,
    maxRetries: config.MARKET_DATA_MAX_RETRIES,
    requestsPerMinute: config.MARKET_DATA_RATE_LIMIT_PER_MINUTE,
    logger: logger.child({ component: 'market-data' }),
  });
  const settings: WorkerSettings = {
    candleLookback: config.SIGNAL_CANDLE_LOOKBACK,
    fetchConcurrency: config.SIGNAL_FETCH_CONCURRENCY,
    candleCloseGraceMs: config.CANDLE_CLOSE_GRACE_MS,
    maxCatchupCandles: config.SIGNAL_MAX_CATCHUP_CANDLES,
    incompleteRefetchMs: config.SIGNAL_INCOMPLETE_REFETCH_MS,
    shardIndex: config.WORKER_SHARD_INDEX,
    shardCount: config.WORKER_SHARD_COUNT,
    strengthModel: strengthModelFromList(config.SIGNAL_STRENGTH_CONFIRMATIONS),
  };
  const runtime = createWorkerRuntime(settings);
  const delivery: DeliverySettings = {
    maxAttempts: config.NOTIFICATION_MAX_ATTEMPTS,
    retryBaseMs: config.NOTIFICATION_RETRY_BASE_MS,
    retryMaxMs: config.NOTIFICATION_RETRY_MAX_MS,
    sendingTimeoutMs: config.NOTIFICATION_SENDING_TIMEOUT_MS,
    maxAgeMs: config.NOTIFICATION_MAX_AGE_MS,
    sweepBatch: config.NOTIFICATION_SWEEP_BATCH,
  };
  const notifier = createNotificationSender(config.NOTIFICATION_DRIVER, logger, {
    projectId: config.FIREBASE_PROJECT_ID,
    serviceAccountPath: config.FIREBASE_SERVICE_ACCOUNT_PATH,
    serviceAccountBase64: config.FIREBASE_SERVICE_ACCOUNT_BASE64,
  });

  const health = new WorkerHealth(Math.max(5 * config.SIGNAL_POLL_INTERVAL_MS, 120_000));
  const retentionPolicy = {
    '1m': config.CANDLE_RETENTION_DAYS_1M,
    '5m': config.CANDLE_RETENTION_DAYS_5M,
    '15m': config.CANDLE_RETENTION_DAYS_15M,
    '1h': config.CANDLE_RETENTION_DAYS_1H,
    '1d': config.CANDLE_RETENTION_DAYS_1D,
  } as const;
  let lastRetentionAt = 0;

  const cycle = async () => {
    try {
      const summary = await runEvaluationCycle({
        prisma,
        marketData,
        notifier,
        logger,
        settings,
        runtime,
        delivery,
      });
      // Always logged: cycle id, pairs, subscriptions evaluated, events, notifications, duration.
      const quiet = summary.triggered === 0 && summary.errors === 0 && summary.pairsFetched === 0;
      logger[quiet ? 'debug' : 'info'](summary, 'evaluation cycle complete');

      // Retry sweep: PENDING after a crash, FAILED with elapsed back-off, stale SENDING
      // claims, and notifications deferred by quiet hours.
      const sweep = await runNotificationSweep({ prisma, notifier, logger, delivery });
      if (sweep.candidates > 0) logger.info(sweep, 'notification sweep complete');

      if (Date.now() - lastRetentionAt >= config.RETENTION_INTERVAL_MS) {
        lastRetentionAt = Date.now();
        const retention = await runCandleRetention(prisma, retentionPolicy);
        logger.info(retention, 'candle retention complete');
      }
      health.recordSuccess();
    } catch (err) {
      health.recordFailure();
      throw err;
    }
  };

  if (process.argv.includes('--once')) {
    await cycle();
    await prisma.$disconnect();
    return;
  }

  logger.info(
    {
      intervalMs: config.SIGNAL_POLL_INTERVAL_MS,
      provider: marketData.name,
      notifications: notifier.name,
    },
    'signal worker started',
  );
  const scheduler = startScheduler({
    intervalMs: config.SIGNAL_POLL_INTERVAL_MS,
    task: cycle,
    logger,
  });
  const healthServer = config.WORKER_HEALTH_PORT
    ? startHealthServer(health, config.WORKER_HEALTH_PORT)
    : null;

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'stopping worker (finishing current cycle)');
    await scheduler.stop();
    healthServer?.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
