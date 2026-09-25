import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createCustomSignal,
  deleteSignal,
  listUserSignals,
  updateSignal,
  upsertAsset,
} from '@signals/db';
import { UnknownSymbolError } from '@signals/market-data';
import { signalCatalog } from '@signals/signal-engine';
import {
  CreateSignalBodySchema,
  SignalCatalogEntrySchema,
  SignalSchema,
  SymbolSchema,
  UpdateSignalBodySchema,
} from '@signals/types';
import type { AppDeps } from '../deps';

const IdParams = z.object({ id: z.string().min(1).max(64) });

export const signalRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/signals/catalog',
    {
      schema: {
        tags: ['signals'],
        summary: 'All supported signal types with descriptions and default parameters',
        response: { 200: z.object({ catalog: z.array(SignalCatalogEntrySchema) }) },
      },
    },
    async () => ({ catalog: signalCatalog() }),
  );

  app.get(
    '/signals',
    {
      schema: {
        tags: ['signals'],
        summary: "List the user's signals",
        querystring: z.object({ ticker: SymbolSchema.optional() }),
        response: { 200: z.object({ signals: z.array(SignalSchema) }) },
      },
    },
    async (req) => ({ signals: await listUserSignals(deps.prisma, req.user.id, req.query.ticker) }),
  );

  app.post(
    '/signals',
    {
      schema: {
        tags: ['signals'],
        summary: 'Create a custom signal (e.g. price above X)',
        body: CreateSignalBodySchema,
        response: { 201: SignalSchema },
      },
    },
    async (req, reply) => {
      const asset = await deps.marketData.getAsset(req.body.ticker);
      if (!asset) throw new UnknownSymbolError(req.body.ticker);
      await upsertAsset(deps.prisma, asset);
      const signal = await createCustomSignal(deps.prisma, {
        userId: req.user.id,
        ticker: asset.symbol,
        signalType: req.body.signalType,
        timeframe: req.body.timeframe ?? deps.config.SIGNAL_DEFAULT_TIMEFRAME,
        parameters: req.body.parameters,
        name: req.body.name,
      });
      return reply.status(201).send(signal);
    },
  );

  app.patch(
    '/signals/:id',
    {
      schema: {
        tags: ['signals'],
        summary: 'Enable/disable a signal, or edit a custom signal',
        params: IdParams,
        body: UpdateSignalBodySchema,
        response: { 200: SignalSchema },
      },
    },
    async (req) => updateSignal(deps.prisma, req.user.id, req.params.id, req.body),
  );

  app.delete(
    '/signals/:id',
    {
      schema: {
        tags: ['signals'],
        summary: 'Delete a custom signal (presets can only be disabled)',
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await deleteSignal(deps.prisma, req.user.id, req.params.id);
      return reply.status(204).send(null);
    },
  );
};
