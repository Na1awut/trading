import { pino } from 'pino';
import { loadConfig } from '@signals/config';
import { createPrismaClient } from '@signals/db';
import { createMarketDataProvider } from '@signals/market-data';
import { createNotificationSender } from '@signals/notifications';
import { createWorkerRuntime, runEvaluationCycle, type WorkerSettings } from './evaluation-cycle';
import { startScheduler } from './scheduler';

async function main() {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, name: 'worker' });
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
  };
  const runtime = createWorkerRuntime(settings);
  const notifier = createNotificationSender(config.NOTIFICATION_DRIVER, logger, {
    projectId: config.FIREBASE_PROJECT_ID,
    serviceAccountPath: config.FIREBASE_SERVICE_ACCOUNT_PATH,
    serviceAccountBase64: config.FIREBASE_SERVICE_ACCOUNT_BASE64,
  });

  const cycle = async () => {
    const summary = await runEvaluationCycle({
      prisma,
      marketData,
      notifier,
      logger,
      settings,
      runtime,
    });
    const level = summary.triggered > 0 || summary.errors > 0 ? 'info' : 'debug';
    logger[level](summary, 'evaluation cycle complete');
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

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'stopping worker (finishing current cycle)');
    await scheduler.stop();
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
