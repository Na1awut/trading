import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { TimeframeSchema } from '@signals/types';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const ms = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);
const days = (def: number) => z.coerce.number().int().min(0).default(def);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.string().url(),

    /* ------------------------------- API ------------------------------- */
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    /** Comma-separated list of allowed origins; "*" only allowed outside production. */
    CORS_ORIGINS: z.string().default('*'),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
    /** Swagger UI + /docs/json. Defaults to on, except in production. */
    ENABLE_API_DOCS: bool.optional(),
    /** Deprecated alias of ENABLE_API_DOCS (Phase 1 name). */
    ENABLE_SWAGGER: bool.optional(),
    /**
     * Which X-Forwarded-For hops to trust for client IPs (rate limiting, logs).
     * false (default) = trust none; a number = hop count; or a comma-separated IP/CIDR list.
     * Never "true" behind the open internet - clients could spoof their IP.
     */
    TRUST_PROXY: z.string().default('false'),
    MAX_DEVICES_PER_USER: z.coerce.number().int().min(1).max(100).default(10),

    /* ------------------------------- Auth ------------------------------ */
    /**
     * firebase: verify Firebase ID tokens (production).
     * dev: accept `Authorization: Bearer dev:<email>` - LOCAL DEVELOPMENT ONLY.
     */
    AUTH_MODE: z.enum(['firebase', 'dev']).default('dev'),
    /** Reject Firebase users whose email is not verified (password sign-ups). */
    AUTH_REQUIRE_EMAIL_VERIFIED: bool.default(false),
    /** Also reject revoked sessions (one extra Firebase call per request). */
    AUTH_CHECK_REVOKED: bool.default(false),

    FIREBASE_PROJECT_ID: z.string().optional(),
    /** Path to a service-account JSON file (kept OUT of the repo). */
    FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
    /** Alternatively the service-account JSON itself, base64-encoded (for secret managers). */
    FIREBASE_SERVICE_ACCOUNT_BASE64: z.string().optional(),

    /* --------------------------- Notifications ------------------------- */
    /** console: log notifications (dev). fcm: send via Firebase Cloud Messaging. */
    NOTIFICATION_DRIVER: z.enum(['console', 'fcm']).default('console'),
    NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    /** First retry delay; doubles per attempt (30 s, 60 s, 120 s, ...). */
    NOTIFICATION_RETRY_BASE_MS: ms(30_000, 1_000),
    NOTIFICATION_RETRY_MAX_MS: ms(30 * 60_000, 1_000),
    /** A SENDING claim older than this is assumed crashed and becomes retryable. */
    NOTIFICATION_SENDING_TIMEOUT_MS: ms(120_000, 10_000),
    /** Undelivered notifications older than this are abandoned (never send stale alerts). */
    NOTIFICATION_MAX_AGE_MS: ms(24 * 3_600_000, 60_000),
    NOTIFICATION_SWEEP_BATCH: z.coerce.number().int().min(1).max(1000).default(100),
    /** Push requests in flight per worker during fan-out and the retry sweep. */
    NOTIFICATION_DELIVERY_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),

    /* ---------------------------- Market data -------------------------- */
    MARKET_DATA_PROVIDER: z.enum(['mock', 'real']).default('mock'),
    /** Staging escape hatch: allow the mock provider when NODE_ENV=production. */
    ALLOW_MOCK_MARKET_DATA: bool.default(false),
    MARKET_DATA_VENDOR: z.string().optional(),
    MARKET_DATA_API_KEY: z.string().optional(),
    MARKET_DATA_BASE_URL: z.string().url().optional(),
    /** Allow MARKET_DATA_BASE_URL outside the vendor's host allowlist (e.g. an egress proxy). */
    MARKET_DATA_ALLOW_CUSTOM_BASE_URL: bool.default(false),
    /**
     * Equity trading sessions to request: regular (default) or extended (pre/post-market,
     * vendor/plan permitting; intraday <= 15m). Never applied to crypto/forex.
     */
    MARKET_SESSION_MODE: z.enum(['regular', 'extended']).default('regular'),
    /** Whether your plan's data is delayed; shown next to prices. */
    MARKET_DATA_DELAYED: bool.default(true),
    MARKET_DATA_TIMEOUT_MS: ms(8_000, 500),
    MARKET_DATA_MAX_RETRIES: z.coerce.number().int().min(0).max(6).default(3),
    /** Client-side request budget per process. Twelve Data Basic is 8/min. */
    MARKET_DATA_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(8),
    MARKET_DATA_QUOTE_TTL_MS: ms(10_000, 1_000),
    /** Quote older than this while the market is open is flagged stale. */
    MARKET_DATA_STALE_QUOTE_MS: ms(30 * 60_000, 60_000),

    /* ------------------------------ Worker ----------------------------- */
    SIGNAL_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
    SIGNAL_DEFAULT_TIMEFRAME: TimeframeSchema.default('5m'),
    SIGNAL_CANDLE_LOOKBACK: z.coerce.number().int().min(60).max(5000).default(250),
    /** Max (ticker, timeframe) pairs fetched concurrently per cycle. */
    SIGNAL_FETCH_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
    /** A candle counts as closed only this long after its interval ends (vendor publish lag). */
    CANDLE_CLOSE_GRACE_MS: ms(5_000),
    /** Missed closed candles evaluated in order after a delay/outage; older ones are skipped. */
    SIGNAL_MAX_CATCHUP_CANDLES: z.coerce.number().int().min(0).max(50).default(3),
    /** Wait before re-fetching a pair whose vendor data lacks the expected closed candle. */
    SIGNAL_INCOMPLETE_REFETCH_MS: ms(60_000, 1_000),
    /** Split (ticker, timeframe) pairs across worker instances: this instance's index / total. */
    WORKER_SHARD_INDEX: z.coerce.number().int().min(0).default(0),
    WORKER_SHARD_COUNT: z.coerce.number().int().min(1).default(1),
    /** Confirmations used by the signal strength model (comma-separated). */
    SIGNAL_STRENGTH_CONFIRMATIONS: z.string().default('volume,rsi,trend,macd'),

    /* ----------------------------- Retention --------------------------- */
    /** Days of MarketCandle history kept per timeframe; 0 = keep forever. */
    CANDLE_RETENTION_DAYS_1M: days(7),
    CANDLE_RETENTION_DAYS_5M: days(60),
    CANDLE_RETENTION_DAYS_15M: days(180),
    CANDLE_RETENTION_DAYS_1H: days(730),
    CANDLE_RETENTION_DAYS_1D: days(0),
    RETENTION_INTERVAL_MS: ms(3_600_000, 60_000),
    /** Enables the API's GET /metrics, which then requires `Authorization: Bearer <token>`. */
    METRICS_TOKEN: z.string().min(16, 'METRICS_TOKEN must be at least 16 characters').optional(),
    /** Worker logs a metrics snapshot this often (0 = never). */
    METRICS_LOG_INTERVAL_MS: ms(300_000),
    /** Optional worker liveness endpoint (GET /health); 0 = disabled. */
    WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(0),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_MODE === 'dev') issue('AUTH_MODE', 'AUTH_MODE=dev is not allowed in production');
      if (env.CORS_ORIGINS.trim() === '*') {
        issue('CORS_ORIGINS', 'Set explicit CORS origins in production');
      }
      if (env.MARKET_DATA_PROVIDER === 'mock' && !env.ALLOW_MOCK_MARKET_DATA) {
        issue(
          'MARKET_DATA_PROVIDER',
          'Mock market data is not allowed in production (set ALLOW_MOCK_MARKET_DATA=true for staging)',
        );
      }
      if (env.TRUST_PROXY.trim().toLowerCase() === 'true') {
        issue(
          'TRUST_PROXY',
          'TRUST_PROXY=true lets clients spoof IPs; use a hop count or CIDR list',
        );
      }
    }
    const needsFirebase = env.AUTH_MODE === 'firebase' || env.NOTIFICATION_DRIVER === 'fcm';
    if (needsFirebase && !env.FIREBASE_PROJECT_ID) {
      issue(
        'FIREBASE_PROJECT_ID',
        'FIREBASE_PROJECT_ID is required when AUTH_MODE=firebase or NOTIFICATION_DRIVER=fcm',
      );
    }
    if (env.MARKET_DATA_PROVIDER === 'real') {
      if (!env.MARKET_DATA_API_KEY)
        issue('MARKET_DATA_API_KEY', 'Required when MARKET_DATA_PROVIDER=real');
      if (!env.MARKET_DATA_VENDOR) {
        issue(
          'MARKET_DATA_VENDOR',
          'Required when MARKET_DATA_PROVIDER=real (supported: twelvedata)',
        );
      } else if (!SUPPORTED_VENDORS.includes(env.MARKET_DATA_VENDOR.toLowerCase())) {
        issue(
          'MARKET_DATA_VENDOR',
          `Unsupported vendor (supported: ${SUPPORTED_VENDORS.join(', ')})`,
        );
      }
    }
    for (const [tf, days] of [
      ['1m', env.CANDLE_RETENTION_DAYS_1M],
      ['5m', env.CANDLE_RETENTION_DAYS_5M],
      ['15m', env.CANDLE_RETENTION_DAYS_15M],
      ['1h', env.CANDLE_RETENTION_DAYS_1H],
      ['1d', env.CANDLE_RETENTION_DAYS_1D],
    ] as const) {
      const min = minRetentionDays(tf, env.SIGNAL_CANDLE_LOOKBACK);
      if (days > 0 && days < min) {
        issue(
          `CANDLE_RETENTION_DAYS_${tf.toUpperCase()}`,
          `${days} days cannot hold SIGNAL_CANDLE_LOOKBACK=${env.SIGNAL_CANDLE_LOOKBACK} ${tf} candles; use >= ${min} or 0 (keep forever)`,
        );
      }
    }
    if (env.WORKER_SHARD_INDEX >= env.WORKER_SHARD_COUNT) {
      issue('WORKER_SHARD_INDEX', 'Must be less than WORKER_SHARD_COUNT');
    }
    const unknownConfirmations = env.SIGNAL_STRENGTH_CONFIRMATIONS.split(',')
      .map((s) => s.trim())
      .filter((s) => s && !STRENGTH_CONFIRMATIONS.includes(s));
    if (unknownConfirmations.length > 0) {
      issue(
        'SIGNAL_STRENGTH_CONFIRMATIONS',
        `Unknown confirmations: ${unknownConfirmations.join(', ')} (allowed: ${STRENGTH_CONFIRMATIONS.join(', ')})`,
      );
    }
  })
  .transform(({ ENABLE_SWAGGER, ...env }) => ({
    ...env,
    ENABLE_API_DOCS: env.ENABLE_API_DOCS ?? ENABLE_SWAGGER ?? env.NODE_ENV !== 'production',
  }));

/**
 * Vendors implemented in packages/market-data (duplicated here so config validation does
 * not depend on the market-data package). Keep in sync with SUPPORTED_VENDORS there.
 */
export const SUPPORTED_VENDORS = ['twelvedata'];
export const STRENGTH_CONFIRMATIONS = ['volume', 'rsi', 'trend', 'macd'];

/**
 * Parse TRUST_PROXY into the value Fastify expects. A hop count N becomes the equivalent
 * trust function `(addr, hop) => hop < N` (proxy-addr semantics).
 */
export function parseTrustProxy(
  value: string,
): boolean | string[] | ((address: string, hop: number) => boolean) {
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_address, hop) => hop < hops;
  }
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export type AppConfig = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Parse and validate configuration. Pure - pass `process.env` or a test object. */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  // Treat empty strings as unset so `.env` placeholders like `FOO=` behave.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return result.data;
}

let cached: AppConfig | undefined;

/** Load `.env` from the repo root (if present, never overriding real env vars) and validate. */
export function loadConfig(): AppConfig {
  if (cached) return cached;
  const envFile = findRepoFile('.env');
  if (envFile) process.loadEnvFile(envFile);
  cached = parseConfig(process.env);
  return cached;
}

export function findRepoFile(name: string, from = process.cwd()): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * pino redact paths used by every process. Values at these paths are replaced with
 * "[REDACTED]" before a log line is written - defence in depth on top of never logging
 * secrets deliberately.
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'authorization',
  '*.authorization',
  'apiKey',
  '*.apiKey',
  'apikey',
  '*.apikey',
  'token',
  '*.token',
  'idToken',
  '*.idToken',
  'privateKey',
  '*.privateKey',
  'private_key',
  '*.private_key',
  'serviceAccount',
  '*.serviceAccount',
];

const TIMEFRAME_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '1d': 1440 } as const;

/**
 * Smallest safe MarketCandle retention (calendar days) for a timeframe so the worker's
 * lookback window is always available from the database. Assumes a conservative 6.5-hour,
 * 5-day trading week (equities) plus 20% margin; crypto (24/7) needs less.
 */
export function minRetentionDays(
  timeframe: keyof typeof TIMEFRAME_MINUTES,
  lookback: number,
): number {
  const perTradingDay = timeframe === '1d' ? 1 : (6.5 * 60) / TIMEFRAME_MINUTES[timeframe];
  const perCalendarDay = (perTradingDay * 5) / 7;
  return Math.max(4, Math.ceil((lookback / perCalendarDay) * 1.2));
}

export * from './metrics';
