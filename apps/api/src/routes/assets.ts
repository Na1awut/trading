import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { listUserSignals } from '@signals/db';
import {
  AssetDetailSchema,
  AssetInfoSchema,
  AssetSearchQuerySchema,
  SignalSchema,
  SymbolSchema,
  TimeframeSchema,
} from '@signals/types';
import type { AppDeps } from '../deps';
import { getAssetDetail } from '../services/asset-detail';

const SymbolParams = z.object({ symbol: SymbolSchema });

const CandleSchema = z.object({
  time: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

export const assetRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/assets/search',
    {
      schema: {
        tags: ['assets'],
        summary: 'Search ticker symbols / names',
        querystring: AssetSearchQuerySchema,
        response: { 200: z.object({ results: z.array(AssetInfoSchema) }) },
      },
    },
    async (req) => ({ results: await deps.marketData.searchAssets(req.query.q, 20) }),
  );

  app.get(
    '/assets/:symbol',
    {
      schema: {
        tags: ['assets'],
        summary: 'Asset detail: quote, indicators (on completed candles) and recent signals',
        params: SymbolParams,
        querystring: z.object({ timeframe: TimeframeSchema.optional() }),
        response: { 200: AssetDetailSchema },
      },
    },
    async (req) =>
      getAssetDetail(deps, req.user.id, req.params.symbol, req.query.timeframe ?? deps.config.SIGNAL_DEFAULT_TIMEFRAME),
  );

  app.get(
    '/assets/:symbol/candles',
    {
      schema: {
        tags: ['assets'],
        summary: 'Candle history (last candle may be in progress)',
        params: SymbolParams,
        querystring: z.object({
          timeframe: TimeframeSchema.optional(),
          limit: z.coerce.number().int().min(1).max(1000).default(100),
        }),
        response: { 200: z.object({ timeframe: TimeframeSchema, candles: z.array(CandleSchema) }) },
      },
    },
    async (req) => {
      const timeframe = req.query.timeframe ?? deps.config.SIGNAL_DEFAULT_TIMEFRAME;
      return {
        timeframe,
        candles: await deps.marketData.getHistoricalCandles(req.params.symbol, timeframe, req.query.limit),
      };
    },
  );

  app.get(
    '/assets/:symbol/signals',
    {
      schema: {
        tags: ['assets', 'signals'],
        summary: "The user's signals (presets + custom) for a ticker",
        params: SymbolParams,
        response: { 200: z.object({ signals: z.array(SignalSchema) }) },
      },
    },
    async (req) => ({ signals: await listUserSignals(deps.prisma, req.user.id, req.params.symbol) }),
  );
};
