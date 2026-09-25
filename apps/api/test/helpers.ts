import { parseConfig } from '@signals/config';
import { createPrismaClient } from '@signals/db';
import { resetDatabase, testDatabaseUrl } from '@signals/db/testing';
import { MockMarketDataProvider, type MarketDataProvider } from '@signals/market-data';
import { RecordingNotificationSender } from '@signals/notifications';
import { buildApp } from '../src/app';
import { DevAuthVerifier, type AuthVerifier } from '../src/plugins/auth';

export const NOW = Date.UTC(2026, 8, 25, 14, 37, 30);
export const DATABASE_URL = testDatabaseUrl('api_test');
export const prisma = createPrismaClient(DATABASE_URL);

export async function makeApp(
  env: Record<string, string> = {},
  overrides: { marketData?: MarketDataProvider; authVerifier?: AuthVerifier } = {},
) {
  const notifier = new RecordingNotificationSender();
  const app = await buildApp(
    {
      config: parseConfig({
        DATABASE_URL,
        LOG_LEVEL: 'silent',
        SIGNAL_DEFAULT_TIMEFRAME: '5m',
        RATE_LIMIT_MAX: '1000',
        ...env,
      }),
      prisma,
      marketData: overrides.marketData ?? new MockMarketDataProvider({ now: () => NOW }),
      notifier,
      authVerifier: overrides.authVerifier ?? new DevAuthVerifier(),
      now: () => NOW,
    },
    { logger: false },
  );
  await app.ready();
  return { app, notifier };
}

export const auth = (email = 'alice@example.com') => ({ authorization: `Bearer dev:${email}` });

export { resetDatabase };
