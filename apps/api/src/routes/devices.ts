import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { RegisterDeviceBodySchema } from '@signals/types';
import type { AppDeps } from '../deps';

export const deviceRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.post(
    '/devices/register',
    {
      schema: {
        tags: ['devices'],
        summary: 'Register (or refresh) a push token for the current user',
        description:
          'Call on every app start and whenever the OS rotates the token. Re-registering an existing token updates lastSeenAt and moves it to the current user.',
        body: RegisterDeviceBodySchema,
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const { token, platform, provider } = req.body;
      // Tokens are unique per physical install: re-registering moves it to this user.
      const device = await deps.prisma.device.upsert({
        where: { token },
        update: { userId: req.user.id, platform, provider, lastSeenAt: new Date() },
        create: { userId: req.user.id, token, platform, provider },
      });
      // Multiple devices per user are supported; cap them so a buggy client (or token
      // churn) cannot grow the fan-out without bound. Least recently seen go first.
      const stale = await deps.prisma.device.findMany({
        where: { userId: req.user.id },
        orderBy: { lastSeenAt: 'desc' },
        skip: deps.config.MAX_DEVICES_PER_USER,
        select: { id: true },
      });
      if (stale.length > 0) {
        await deps.prisma.device.deleteMany({ where: { id: { in: stale.map((d) => d.id) } } });
      }
      return reply.status(201).send({ id: device.id });
    },
  );

  app.post(
    '/devices/unregister',
    {
      schema: {
        tags: ['devices'],
        summary: 'Remove a push token (e.g. on sign-out)',
        body: z.object({ token: z.string().min(1).max(4096) }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await deps.prisma.device.deleteMany({
        where: { token: req.body.token, userId: req.user.id },
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/devices/test',
    {
      config: { rateLimit: { max: 5, timeWindow: 60_000 } },
      schema: {
        tags: ['devices'],
        summary: "Send a test notification to the user's devices",
        response: { 200: z.object({ devices: z.number(), delivered: z.number() }) },
      },
    },
    async (req) => {
      const devices = await deps.prisma.device.findMany({ where: { userId: req.user.id } });
      if (devices.length === 0) return { devices: 0, delivered: 0 };
      const results = await deps.notifier.send(
        devices.map((d) => ({ token: d.token, provider: d.provider, platform: d.platform })),
        {
          title: 'Test notification',
          body: 'Push notifications are working.',
          data: { type: 'test' },
        },
      );
      return { devices: devices.length, delivered: results.filter((r) => r.success).length };
    },
  );
};
