/**
 * Development seed: a demo user (log in with dev token "dev:demo@example.com") with
 * NVDA, AAPL and SPY on the watchlist and preset signal subscriptions.
 */
import { MockMarketDataProvider } from '@signals/market-data';
import type { Timeframe } from '@signals/types';
import { addToWatchlist, createPrismaClient, findOrCreateUser } from '../src';

const prisma = createPrismaClient();
const provider = new MockMarketDataProvider();
const timeframe = (process.env.SIGNAL_DEFAULT_TIMEFRAME ?? '1m') as Timeframe;

async function main() {
  const user = await findOrCreateUser(prisma, {
    firebaseUid: 'dev:demo@example.com',
    email: 'demo@example.com',
    displayName: 'Demo User',
  });
  for (const symbol of ['NVDA', 'AAPL', 'SPY']) {
    const asset = await provider.getAsset(symbol);
    if (asset) await addToWatchlist(prisma, { userId: user.id, asset, timeframe });
  }
  console.log(`Seeded user ${user.email} (${user.id}) with NVDA, AAPL, SPY on ${timeframe}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
