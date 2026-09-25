import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getSettings, updateSettings } from '@signals/db';
import { MeSchema, NotificationSettingsSchema, UpdateNotificationSettingsBodySchema } from '@signals/types';
import type { AppDeps } from '../deps';

export const meRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/me',
    { schema: { tags: ['user'], summary: 'Current user and notification settings', response: { 200: MeSchema } } },
    async (req) => {
      const user = await deps.prisma.user.findUniqueOrThrow({ where: { id: req.user.id } });
      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        settings: await getSettings(deps.prisma, user.id),
      };
    },
  );

  app.patch(
    '/me/settings',
    {
      schema: {
        tags: ['user'],
        summary: 'Update notification settings (global on/off, category toggles, future quiet hours)',
        body: UpdateNotificationSettingsBodySchema,
        response: { 200: NotificationSettingsSchema },
      },
    },
    async (req) => updateSettings(deps.prisma, req.user.id, req.body),
  );
};
