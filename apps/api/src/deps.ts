import type { AppConfig, Metrics } from '@signals/config';
import type { PrismaClient } from '@signals/db';
import type { MarketDataProvider } from '@signals/market-data';
import type { NotificationSender } from '@signals/notifications';
import type { AuthVerifier } from './plugins/auth';

export interface AppDeps {
  config: AppConfig;
  prisma: PrismaClient;
  marketData: MarketDataProvider;
  notifier: NotificationSender;
  authVerifier: AuthVerifier;
  /** Optional metrics registry (GET /metrics when METRICS_TOKEN is set). */
  metrics?: Metrics;
  /** Injectable clock (tests). */
  now?: () => number;
}
