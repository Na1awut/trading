import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DISCLAIMER } from '@signals/types';
import type { AppDeps } from '../deps';

const startedAt = Date.now();
const VERSION = process.env.APP_VERSION ?? '0.2.0';

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const Check = z.object({ status: z.enum(['ok', 'fail']), detail: z.string().optional() });

export const healthRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  // Liveness: the process is up and serving. No dependencies - a database or vendor
  // outage must not make the orchestrator restart healthy API processes.
  app.get(
    '/health',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['system'],
        summary: 'Liveness: process is running (no dependency checks)',
        response: {
          200: z.object({
            status: z.literal('ok'),
            uptimeSeconds: z.number(),
            version: z.string(),
            marketData: z.string(),
            marketDataDelayed: z.boolean(),
            disclaimer: z.string(),
          }),
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      version: VERSION,
      marketData: deps.marketData.name,
      marketDataDelayed: deps.marketData.delayed,
      disclaimer: DISCLAIMER,
    }),
  );

  // Readiness: can this instance serve traffic? Database reachable and required
  // configuration consistent. The market-data vendor is deliberately NOT checked: a vendor
  // outage degrades prices (stale/unavailable flags) but everything else still works.
  app.get(
    '/ready',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['system'],
        summary: 'Readiness: database reachable and configuration valid',
        response: {
          200: z.object({ status: z.literal('ready'), checks: z.record(z.string(), Check) }),
          503: z.object({ status: z.literal('not_ready'), checks: z.record(z.string(), Check) }),
        },
      },
    },
    async (_req, reply) => {
      const checks: Record<string, z.infer<typeof Check>> = {};
      try {
        await withTimeout(deps.prisma.$queryRaw`SELECT 1`, 2_000);
        checks.database = { status: 'ok' };
      } catch (err) {
        checks.database = { status: 'fail', detail: (err as Error).message.slice(0, 120) };
      }
      const cfg = deps.config;
      const configProblems: string[] = [];
      if (cfg.AUTH_MODE !== deps.authVerifier.mode)
        configProblems.push('auth verifier does not match AUTH_MODE');
      if (cfg.NODE_ENV === 'production' && deps.authVerifier.mode !== 'firebase')
        configProblems.push('dev auth in production');
      if (
        (cfg.AUTH_MODE === 'firebase' || cfg.NOTIFICATION_DRIVER === 'fcm') &&
        !cfg.FIREBASE_PROJECT_ID
      ) {
        configProblems.push('FIREBASE_PROJECT_ID missing');
      }
      checks.config = configProblems.length
        ? { status: 'fail', detail: configProblems.join('; ') }
        : { status: 'ok' };

      const ready = Object.values(checks).every((c) => c.status === 'ok');
      if (!ready) {
        return reply.status(503).send({ status: 'not_ready' as const, checks });
      }
      return { status: 'ready' as const, checks };
    },
  );
};
