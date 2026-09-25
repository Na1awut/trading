import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DISCLAIMER } from '@signals/types';
import type { AppDeps } from '../deps';

export const healthRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness/readiness check',
        response: {
          200: z.object({
            status: z.literal('ok'),
            database: z.literal('ok'),
            marketData: z.string(),
            marketDataDelayed: z.boolean(),
            disclaimer: z.string(),
          }),
        },
      },
    },
    async () => {
      await deps.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ok' as const,
        database: 'ok' as const,
        marketData: deps.marketData.name,
        marketDataDelayed: deps.marketData.delayed,
        disclaimer: DISCLAIMER,
      };
    },
  );
};
