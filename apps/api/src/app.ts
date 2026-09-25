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
import { parseTrustProxy } from '@signals/config';
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

export async function buildApp(deps: AppDeps, opts: { logger?: FastifyBaseLogger | false } = {}) {
  const { config } = deps;
  const logger: FastifyBaseLogger =
    opts.logger || pino({ level: opts.logger === false ? 'silent' : config.LOG_LEVEL });
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
    bodyLimit: 64 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

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
    // Per-user when authenticated (user set in preHandler is not yet available in onRequest,
    // so key by bearer token), otherwise per IP.
    keyGenerator: (req) => req.headers.authorization ?? req.ip,
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
