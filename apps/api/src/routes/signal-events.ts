import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotFoundError, listSignalEvents, toSignalEventDTO } from '@signals/db';
import { SignalEventSchema, SignalEventsQuerySchema } from '@signals/types';
import type { AppDeps } from '../deps';

export const signalEventRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/signal-events',
    {
      schema: {
        tags: ['signals'],
        summary: 'Signal history, newest first (cursor pagination via `before`)',
        querystring: SignalEventsQuerySchema,
        response: {
          200: z.object({ events: z.array(SignalEventSchema), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (req) => {
      const events = await listSignalEvents(deps.prisma, req.user.id, req.query);
      const nextCursor = events.length === req.query.limit ? (events.at(-1)?.id ?? null) : null;
      return { events, nextCursor };
    },
  );

  app.get(
    '/signal-events/:id',
    {
      schema: {
        tags: ['signals'],
        summary: 'One signal event with the full explanation',
        params: z.object({ id: z.string().min(1).max(64) }),
        response: { 200: SignalEventSchema },
      },
    },
    async (req) => {
      const event = await deps.prisma.signalEvent.findFirst({
        where: { id: req.params.id, userId: req.user.id },
      });
      if (!event) throw new NotFoundError('Signal event not found');
      return toSignalEventDTO(event);
    },
  );
};
