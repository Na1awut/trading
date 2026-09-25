import Fastify, { type FastifyBaseLogger } from 'fastify';
import { pino } from 'pino';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { LOG_REDACT_PATHS, parseTrustProxy } from '@signals/config';
import { DISCLAIMER } from '@signals/types';
import type { AppDeps } from './deps';
import { createAuthenticateHook } from './plugins/auth';
import { registerErrorHandler } from './plugins/errors';
import { assetRoutes } from './routes/assets';
import { deviceRoutes } from './routes/devices';
import { healthRoutes } from './routes/health';
import { meRoutes } from './routes/me';
import { signalEventRoutes } from './routes/signal-events';
import { signalRoutes } from './routes/signals';
import { watchlistRoutes } from './routes/watchlist';

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export async function buildApp(deps: AppDeps, opts: { logger?: FastifyBaseLogger | false } = {}) {
  const { config } = deps;
  // Defence in depth: config validation already rejects AUTH_MODE=dev in production.
  if (config.NODE_ENV === 'production' && deps.authVerifier.mode !== 'firebase') {
    throw new Error('Refusing to start: dev authentication is not allowed in production');
  }
  const logger: FastifyBaseLogger =
    opts.logger ||
    pino({ level: opts.logger === false ? 'silent' : config.LOG_LEVEL, redact: LOG_REDACT_PATHS });
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
    bodyLimit: 64 * 1024,
    // Correlation id: accept a well-formed x-request-id from the caller/proxy, else mint one.
    requestIdHeader: false,
    requestIdLogLabel: 'requestId',
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();
  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  // JSON API: CSP is irrelevant for responses and would break the Swagger UI assets.
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin:
      config.CORS_ORIGINS.trim() === '*'
        ? true
        : config.CORS_ORIGINS.split(',').map((o) => o.trim()),
  });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    // Per client IP. Keying on the bearer token would let a client dodge the limit by sending
    // random tokens and would keep tokens in memory. Correct IPs behind a load balancer
    // require TRUST_PROXY (hop count / CIDRs) - never "true".
    keyGenerator: (req) => req.ip,
  });

  if (config.ENABLE_API_DOCS) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Stock Signal Alerts API',
          version: '0.1.0',
          description: `Watchlists, technical signals and alert history.\n\n**${DISCLAIMER}**`,
        },
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              description:
                'Firebase ID token (AUTH_MODE=firebase) or `dev:<email>` (AUTH_MODE=dev)',
            },
          },
        },
        security: [{ bearerAuth: [] }],
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  await app.register(healthRoutes, deps);

  // Everything below requires authentication.
  const authenticate = createAuthenticateHook(deps.authVerifier, deps.prisma);
  await app.register(async (secured) => {
    secured.addHook('onRequest', authenticate);
    await secured.register(meRoutes, deps);
    await secured.register(watchlistRoutes, deps);
    await secured.register(assetRoutes, deps);
    await secured.register(signalRoutes, deps);
    await secured.register(signalEventRoutes, deps);
    await secured.register(deviceRoutes, deps);
  });

  return app;
}
