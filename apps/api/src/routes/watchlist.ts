import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { addToWatchlist, listWatchlistItems, removeFromWatchlist, setTickerAlerts } from '@signals/db';
import type { MarketDataProvider } from '@signals/market-data';
import { UnknownSymbolError } from '@signals/market-data';
import {
  AddWatchlistItemBodySchema,
  SymbolSchema,
  UpdateWatchlistItemBodySchema,
  WatchlistItemSchema,
  type Quote,
  type WatchlistItem,
} from '@signals/types';
import type { AppDeps } from '../deps';

type ItemWithAsset = Awaited<ReturnType<typeof listWatchlistItems>>[number];

async function safeQuote(provider: MarketDataProvider, symbol: string): Promise<Quote | null> {
  try {
    return await provider.getQuote(symbol);
  } catch {
    return null; // one bad symbol must not break the whole watchlist
  }
}

function toDTO(item: ItemWithAsset, quote: Quote | null): WatchlistItem {
  return {
    symbol: item.symbol,
    name: item.asset.name,
    assetClass: item.asset.assetClass,
    exchange: item.asset.exchange,
    currency: item.asset.currency,
    alertsEnabled: item.alertsEnabled,
    addedAt: item.addedAt.toISOString(),
    quote,
  };
}

const SymbolParams = z.object({ symbol: SymbolSchema });

export const watchlistRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/watchlist',
    {
      schema: {
        tags: ['watchlist'],
        summary: 'Watchlist with latest price, % change and update time',
        response: { 200: z.object({ items: z.array(WatchlistItemSchema) }) },
      },
    },
    async (req) => {
      const items = await listWatchlistItems(deps.prisma, req.user.id);
      const quotes = await Promise.all(items.map((i) => safeQuote(deps.marketData, i.symbol)));
      return { items: items.map((item, k) => toDTO(item, quotes[k] ?? null)) };
    },
  );

  app.post(
    '/watchlist',
    {
      schema: {
        tags: ['watchlist'],
        summary: 'Add a ticker (idempotent). Subscribes to preset signals for it.',
        body: AddWatchlistItemBodySchema,
        response: { 200: z.object({ item: WatchlistItemSchema }), 201: z.object({ item: WatchlistItemSchema }) },
      },
    },
    async (req, reply) => {
      const asset = await deps.marketData.getAsset(req.body.symbol);
      if (!asset) throw new UnknownSymbolError(req.body.symbol);
      const { item, created } = await addToWatchlist(deps.prisma, {
        userId: req.user.id,
        asset,
        timeframe: deps.config.SIGNAL_DEFAULT_TIMEFRAME,
      });
      return reply.status(created ? 201 : 200).send({ item: toDTO(item, await safeQuote(deps.marketData, item.symbol)) });
    },
  );

  app.patch(
    '/watchlist/:symbol',
    {
      schema: {
        tags: ['watchlist'],
        summary: 'Enable/disable all alerts for one ticker',
        params: SymbolParams,
        body: UpdateWatchlistItemBodySchema,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await setTickerAlerts(deps.prisma, req.user.id, req.params.symbol, req.body.alertsEnabled);
      return reply.status(204).send(null);
    },
  );

  app.delete(
    '/watchlist/:symbol',
    {
      schema: {
        tags: ['watchlist'],
        summary: 'Remove a ticker and its signals (history is kept)',
        params: SymbolParams,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await removeFromWatchlist(deps.prisma, req.user.id, req.params.symbol);
      return reply.status(204).send(null);
    },
  );
};
