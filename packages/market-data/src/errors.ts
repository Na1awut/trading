/**
 * Normalised market-data errors. Vendor-specific error formats are translated into these
 * codes inside packages/market-data and never leak to callers.
 */
export type MarketDataErrorCode =
  | 'UNAUTHORIZED' // bad/missing API key (401) - never retried
  | 'FORBIDDEN' // plan does not include this data (403) - never retried
  | 'INVALID_SYMBOL' // unknown / unsupported symbol - never retried
  | 'BAD_REQUEST' // other 4xx - never retried
  | 'RATE_LIMITED' // 429 or local rate limiter - retried
  | 'TIMEOUT' // request exceeded MARKET_DATA_TIMEOUT_MS - retried
  | 'NETWORK' // connection reset / DNS / TLS - retried
  | 'UPSTREAM_UNAVAILABLE' // 5xx - retried
  | 'BAD_RESPONSE' // response failed schema validation - never retried
  | 'NOT_CONFIGURED'; // provider misconfiguration

const RETRYABLE: ReadonlySet<MarketDataErrorCode> = new Set([
  'RATE_LIMITED',
  'TIMEOUT',
  'NETWORK',
  'UPSTREAM_UNAVAILABLE',
]);

export class MarketDataError extends Error {
  readonly code: MarketDataErrorCode;
  readonly retryable: boolean;
  readonly vendor: string;
  readonly httpStatus?: number;
  readonly symbol?: string;
  /** Server-suggested wait (Retry-After) in ms, when provided. */
  readonly retryAfterMs?: number;

  constructor(
    code: MarketDataErrorCode,
    message: string,
    opts: { vendor?: string; httpStatus?: number; symbol?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'MarketDataError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.vendor = opts.vendor ?? 'unknown';
    this.httpStatus = opts.httpStatus;
    this.symbol = opts.symbol;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export class UnknownSymbolError extends MarketDataError {
  constructor(symbol: string, vendor = 'unknown') {
    super('INVALID_SYMBOL', `Unknown symbol: ${symbol}`, { vendor, symbol });
    this.name = 'UnknownSymbolError';
  }
}

export class ProviderNotConfiguredError extends MarketDataError {
  constructor(message: string) {
    super('NOT_CONFIGURED', message);
    this.name = 'ProviderNotConfiguredError';
  }
}
