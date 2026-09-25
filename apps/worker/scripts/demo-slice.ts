/**
 * End-to-end vertical slice against your local database:
 *
 *   user (demo@example.com) -> adds NVDA -> candles with an EMA 9/21 bullish cross
 *   -> worker cycle evaluates -> SignalEvent saved -> notification "sent" (console)
 *   -> visible in GET /signal-events and in the mobile app's Signal History.
 *
 * Run: pnpm demo:slice   (log in to the app as demo@example.com in dev auth mode)
 */
import { pino } from 'pino';
import { loadConfig } from '@signals/config';
import {
  addToWatchlist,
  createPrismaClient,
  findOrCreateUser,
  listSignalEvents,
} from '@signals/db';
import { MockMarketDataProvider, ScriptedMarketDataProvider } from '@signals/market-data';
import { createNotificationSender } from '@signals/notifications';
import { runEvaluationCycle } from '../src/evaluation-cycle';
import { buildEmaBullishCrossScenario } from '../src/scenarios';

const config = loadConfig();
const logger = pino({ level: 'info', name: 'demo', transport: undefined });
const prisma = createPrismaClient(config.DATABASE_URL);
const timeframe = config.SIGNAL_DEFAULT_TIMEFRAME;

async function main() {
  const step = (n: number, text: string) => console.info(`\n[${n}] ${text}`);

  step(1, 'User demo@example.com adds NVDA to the watchlist');
  const user = await findOrCreateUser(prisma, {
    firebaseUid: 'dev:demo@example.com',
    email: 'demo@example.com',
  });
  const nvda = (await new MockMarketDataProvider().getAsset('NVDA'))!;
  await addToWatchlist(prisma, { userId: user.id, asset: nvda, timeframe });
  const hasDevice = await prisma.device.count({ where: { userId: user.id } });
  if (!hasDevice) {
    await prisma.device.create({
      data: {
        userId: user.id,
        token: 'demo-console-device-token',
        platform: 'android',
        provider: 'FCM',
      },
    });
  }

  step(
    2,
    `Market data: NVDA ${timeframe} candles where the last completed candle is an EMA 9/21 bullish cross`,
  );
  const now = Date.now();
  const candles = buildEmaBullishCrossScenario({ now, timeframe, basePrice: 182 });
  const provider = new ScriptedMarketDataProvider(() => now).setCandles('NVDA', timeframe, candles);
  // Demo-only: forget prior transition state for NVDA so this candle is evaluated fresh.
  await prisma.signalState.deleteMany({
    where: { signalDefinition: { ticker: 'NVDA', timeframe } },
  });

  step(3, 'Worker evaluates signals (completed candles only)');
  const notifier = createNotificationSender('console', logger);
  const run = () =>
    runEvaluationCycle({
      prisma,
      marketData: provider,
      notifier,
      logger,
      ingest: false,
      now: () => now,
    });
  const summary = await run();
  console.info(summary);

  step(4, 'SignalEvent stored in history');
  const [event] = await listSignalEvents(prisma, user.id, { ticker: 'NVDA', limit: 1 });
  console.info(JSON.stringify(event, null, 2));

  step(5, 'Next poll on the same candle -> no duplicate');
  const again = await run();
  console.info({ eventsCreated: again.eventsCreated, skippedUpToDate: again.skippedUpToDate });

  console.info('\nOpen the app (dev login: demo@example.com) -> Signal History to see the event,');
  console.info(
    'or: curl -H "Authorization: Bearer dev:demo@example.com" localhost:4000/signal-events',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
