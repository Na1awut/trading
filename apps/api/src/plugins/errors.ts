import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { ConflictError, DomainValidationError, NotFoundError } from '@signals/db';
import { ProviderNotConfiguredError, UnknownSymbolError } from '@signals/market-data';

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    let statusCode = 500;
    let message = 'Internal server error';

    if (hasZodFastifySchemaValidationErrors(err)) {
      statusCode = 400;
      message = err.validation
        .map((v) => `${v.instancePath.replace(/^\//, '').replace(/\//g, '.') || err.validationContext}: ${v.message}`)
        .join('; ');
    } else if (err instanceof NotFoundError || err instanceof ConflictError || err instanceof DomainValidationError) {
      statusCode = err.statusCode;
      message = err.message;
    } else if (err instanceof UnknownSymbolError) {
      statusCode = 404;
      message = err.message;
    } else if (err instanceof ProviderNotConfiguredError) {
      statusCode = 503;
      message = 'Market data provider is not configured';
      request.log.error({ err }, message);
    } else if (isResponseSerializationError(err)) {
      request.log.error({ err, cause: err.cause }, 'response serialization failed');
    } else if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      statusCode = err.statusCode;
      message = err.message;
    } else {
      request.log.error({ err }, 'unhandled error');
    }

    void reply.status(statusCode).send({
      statusCode,
      error: STATUS_TEXT[statusCode] ?? 'Error',
      message,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({ statusCode: 404, error: 'Not Found', message: `Route ${request.method} ${request.url} not found` });
  });
}
