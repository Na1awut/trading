import type { AppConfig } from '@signals/config';
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
  /** Injectable clock (tests). */
  now?: () => number;
}
