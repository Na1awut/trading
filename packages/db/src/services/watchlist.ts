import type { AssetInfo, Timeframe } from '@signals/types';
import type { Db } from '../client';
import { NotFoundError } from '../errors';
import { subscribeToPresets } from './presets';

export async function getDefaultWatchlist(db: Db, userId: string) {
  const existing = await db.watchlist.findFirst({ where: { userId, isDefault: true } });
  if (existing) return existing;
  return db.watchlist.upsert({
    where: { userId_name: { userId, name: 'My Watchlist' } },
    update: { isDefault: true },
    create: { userId, name: 'My Watchlist', isDefault: true },
  });
}

export async function upsertAsset(db: Db, asset: AssetInfo) {
  // Pick fields explicitly: providers may return richer objects than AssetInfo.
  const data = {
    name: asset.name,
    assetClass: asset.assetClass,
    exchange: asset.exchange,
    currency: asset.currency,
  };
  return db.asset.upsert({
    where: { symbol: asset.symbol },
    update: data,
    create: { symbol: asset.symbol, ...data },
  });
}

export async function listWatchlistItems(db: Db, userId: string) {
  const wl = await getDefaultWatchlist(db, userId);
  return db.watchlistItem.findMany({
    where: { watchlistId: wl.id },
    include: { asset: true },
    orderBy: [{ position: 'asc' }, { addedAt: 'asc' }],
  });
}

/**
 * Add a ticker to the user's default watchlist and subscribe them to the preset signals.
 * Idempotent: adding an existing ticker returns the existing item (`created: false`).
 */
export async function addToWatchlist(
  db: Db,
  params: { userId: string; asset: AssetInfo; timeframe: Timeframe },
) {
  const { userId, asset, timeframe } = params;
  const wl = await getDefaultWatchlist(db, userId);
  await upsertAsset(db, asset);
  const existing = await db.watchlistItem.findUnique({
    where: { watchlistId_symbol: { watchlistId: wl.id, symbol: asset.symbol } },
    include: { asset: true },
  });
  if (existing) return { item: existing, created: false };
  const count = await db.watchlistItem.count({ where: { watchlistId: wl.id } });
  const item = await db.watchlistItem.create({
    data: { watchlistId: wl.id, symbol: asset.symbol, position: count },
    include: { asset: true },
  });
  await subscribeToPresets(db, userId, asset.symbol, timeframe);
  return { item, created: true };
}

/** Remove a ticker and the user's signals for it. Signal history is kept. */
export async function removeFromWatchlist(db: Db, userId: string, symbol: string): Promise<void> {
  const wl = await getDefaultWatchlist(db, userId);
  const { count } = await db.watchlistItem.deleteMany({ where: { watchlistId: wl.id, symbol } });
  if (count === 0) throw new NotFoundError(`${symbol} is not in your watchlist`);
  await db.signalSubscription.deleteMany({
    where: { userId, signalDefinition: { ticker: symbol } },
  });
  await db.signalDefinition.deleteMany({ where: { ownerId: userId, ticker: symbol } });
}

export async function setTickerAlerts(
  db: Db,
  userId: string,
  symbol: string,
  alertsEnabled: boolean,
) {
  const wl = await getDefaultWatchlist(db, userId);
  const { count } = await db.watchlistItem.updateMany({
    where: { watchlistId: wl.id, symbol },
    data: { alertsEnabled },
  });
  if (count === 0) throw new NotFoundError(`${symbol} is not in your watchlist`);
}
