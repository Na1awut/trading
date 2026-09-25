import { LOG_REDACT_PATHS, loadConfig } from '@signals/config';
import { createPrismaClient } from '@signals/db';
import { CachedMarketDataProvider, createMarketDataProvider } from '@signals/market-data';
import { createNotificationSender, getFirebaseAdminApp } from '@signals/notifications';
import { getAuth } from 'firebase-admin/auth';
import { pino } from 'pino';
import { buildApp } from './app';
import { DevAuthVerifier, FirebaseAuthVerifier } from './plugins/auth';

async function main() {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, name: 'api', redact: LOG_REDACT_PATHS });
  const prisma = createPrismaClient(config.DATABASE_URL);
  const firebase = {
    projectId: config.FIREBASE_PROJECT_ID,
    serviceAccountPath: config.FIREBASE_SERVICE_ACCOUNT_PATH,
    serviceAccountBase64: config.FIREBASE_SERVICE_ACCOUNT_BASE64,
  };
  const marketData = new CachedMarketDataProvider(
    createMarketDataProvider({
      provider: config.MARKET_DATA_PROVIDER,
      vendor: config.MARKET_DATA_VENDOR,
      apiKey: config.MARKET_DATA_API_KEY,
      baseUrl: config.MARKET_DATA_BASE_URL,
      allowCustomBaseUrl: config.MARKET_DATA_ALLOW_CUSTOM_BASE_URL,
      delayed: config.MARKET_DATA_DELAYED,
      timeoutMs: config.MARKET_DATA_TIMEOUT_MS,
      maxRetries: config.MARKET_DATA_MAX_RETRIES,
      requestsPerMinute: config.MARKET_DATA_RATE_LIMIT_PER_MINUTE,
      sessionMode: config.MARKET_SESSION_MODE,
      logger: logger.child({ component: 'market-data' }),
    }),
    {
      quoteTtlMs: config.MARKET_DATA_QUOTE_TTL_MS,
      candleCloseGraceMs: config.CANDLE_CLOSE_GRACE_MS,
    },
  );
  const authVerifier =
    config.AUTH_MODE === 'firebase'
      ? new FirebaseAuthVerifier(getAuth(getFirebaseAdminApp(firebase)), {
          requireEmailVerified: config.AUTH_REQUIRE_EMAIL_VERIFIED,
          checkRevoked: config.AUTH_CHECK_REVOKED,
        })
      : new DevAuthVerifier();

  const app = await buildApp(
    {
      config,
      prisma,
      marketData,
      authVerifier,
      notifier: createNotificationSender(config.NOTIFICATION_DRIVER, logger, firebase),
    },
    { logger },
  );
  if (config.AUTH_MODE === 'dev') {
    app.log.warn('AUTH_MODE=dev: accepting "Bearer dev:<email>" tokens. Never use in production.');
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  app.log.info(`API docs: http://localhost:${config.API_PORT}/docs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
