import type { FastifyError, FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { ConflictError, DomainValidationError, NotFoundError } from '@signals/db';
import {
  MarketDataError,
  ProviderNotConfiguredError,
  UnknownSymbolError,
} from '@signals/market-data';

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    let statusCode = 500;
    let message = 'Internal server error';
    let code: string | undefined;

    if (hasZodFastifySchemaValidationErrors(err)) {
      statusCode = 400;
      message = err.validation
        .map(
          (v) =>
            `${v.instancePath.replace(/^\//, '').replace(/\//g, '.') || err.validationContext}: ${v.message}`,
        )
        .join('; ');
    } else if (
      err instanceof NotFoundError ||
      err instanceof ConflictError ||
      err instanceof DomainValidationError
    ) {
      statusCode = err.statusCode;
      message = err.message;
    } else if (err instanceof UnknownSymbolError) {
      statusCode = 404;
      message = err.message;
    } else if (err instanceof MarketDataError) {
      // The vendor failed. Transient conditions are 503 (retry later); configuration or plan
      // problems (bad key, feature not on plan, malformed vendor response) are 502. Vendor
      // details stay in the logs; clients get a stable code.
      if (err.code === 'INVALID_SYMBOL') {
        statusCode = 404;
        message = 'Unknown symbol';
      } else {
        statusCode = err.retryable ? 503 : 502;
        message = 'Market data is temporarily unavailable';
        code = 'MARKET_DATA_UNAVAILABLE';
        if (err.code === 'RATE_LIMITED') void reply.header('retry-after', '30');
        request.log[err.retryable ? 'warn' : 'error'](
          { code: err.code, vendor: err.vendor, httpStatus: err.httpStatus, symbol: err.symbol },
          'market data request failed',
        );
      }
    } else if (err instanceof ProviderNotConfiguredError) {
      statusCode = 503;
      message = 'Market data provider is not configured';
      request.log.error({ err }, message);
    } else if (isResponseSerializationError(err)) {
      request.log.error({ err, cause: err.cause }, 'response serialization failed');
    } else if (
      typeof err.statusCode === 'number' &&
      err.statusCode >= 400 &&
      err.statusCode < 500
    ) {
      statusCode = err.statusCode;
      message = err.message;
    } else {
      request.log.error({ err }, 'unhandled error');
    }

    void reply.status(statusCode).send({
      statusCode,
      error: STATUS_TEXT[statusCode] ?? 'Error',
      message,
      ...(code ? { code } : {}),
    });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
    });
  });
}
