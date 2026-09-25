import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  addToWatchlist,
  listWatchlistItems,
  removeFromWatchlist,
  setTickerAlerts,
} from '@signals/db';
import { MarketDataError, UnknownSymbolError, assessQuoteFreshness } from '@signals/market-data';
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
type QuoteResult = { quote: Quote | null; error: string | null };

/** One failing symbol (or a vendor outage) must not break the whole watchlist. */
async function safeQuote(deps: AppDeps, symbol: string): Promise<QuoteResult> {
  try {
    return { quote: await deps.marketData.getQuote(symbol), error: null };
  } catch (err) {
    const code = err instanceof MarketDataError ? err.code : 'UNKNOWN';
    return {
      quote: null,
      error:
        code === 'RATE_LIMITED'
          ? 'Price temporarily unavailable (rate limited)'
          : 'Price unavailable',
    };
  }
}

function toDTO(deps: AppDeps, item: ItemWithAsset, { quote, error }: QuoteResult): WatchlistItem {
  const now = deps.now?.() ?? Date.now();
  return {
    symbol: item.symbol,
    name: item.asset.name,
    assetClass: item.asset.assetClass,
    exchange: item.asset.exchange,
    currency: item.asset.currency,
    alertsEnabled: item.alertsEnabled,
    addedAt: item.addedAt.toISOString(),
    quote,
    dataStatus: quote
      ? assessQuoteFreshness(quote, now, deps.config.MARKET_DATA_STALE_QUOTE_MS)
      : null,
    quoteError: error,
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
      const quotes = await Promise.all(items.map((i) => safeQuote(deps, i.symbol)));
      return { items: items.map((item, k) => toDTO(deps, item, quotes[k]!)) };
    },
  );

  app.post(
    '/watchlist',
    {
      schema: {
        tags: ['watchlist'],
        summary: 'Add a ticker (idempotent). Subscribes to preset signals for it.',
        body: AddWatchlistItemBodySchema,
        response: {
          200: z.object({ item: WatchlistItemSchema }),
          201: z.object({ item: WatchlistItemSchema }),
        },
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
      return reply
        .status(created ? 201 : 200)
        .send({ item: toDTO(deps, item, await safeQuote(deps, item.symbol)) });
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
