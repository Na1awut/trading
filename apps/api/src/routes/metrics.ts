import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../deps';

function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * Internal operational metrics. Only registered when METRICS_TOKEN is configured, and
 * requires `Authorization: Bearer <METRICS_TOKEN>` (a separate secret from user auth).
 */
export const metricsRoutes: FastifyPluginAsync<AppDeps> = async (app, deps) => {
  const token = deps.config.METRICS_TOKEN;
  const metrics = deps.metrics;
  if (!token || !metrics) return;
  app.get('/metrics', { schema: { hide: true } }, async (req, reply) => {
    if (!tokenMatches(req.headers.authorization, token)) {
      return reply
        .status(401)
        .send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid metrics token' });
    }
    if ((req.query as Record<string, string>).format === 'prometheus') {
      return reply.type('text/plain; version=0.0.4').send(metrics.prometheus());
    }
    return metrics.snapshot();
  });
};
