import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { TimeframeSchema } from '@signals/types';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().url(),

    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    /** Comma-separated list of allowed origins; "*" only allowed outside production. */
    CORS_ORIGINS: z.string().default('*'),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
    ENABLE_SWAGGER: bool.default(true),

    /**
     * firebase: verify Firebase ID tokens (production).
     * dev: accept `Authorization: Bearer dev:<email>` - LOCAL DEVELOPMENT ONLY.
     */
    AUTH_MODE: z.enum(['firebase', 'dev']).default('dev'),

    FIREBASE_PROJECT_ID: z.string().optional(),
    /** Path to a service-account JSON file (kept OUT of the repo). */
    FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
    /** Alternatively the service-account JSON itself, base64-encoded (for secret managers). */
    FIREBASE_SERVICE_ACCOUNT_BASE64: z.string().optional(),

    /** console: log notifications (dev). fcm: send via Firebase Cloud Messaging. */
    NOTIFICATION_DRIVER: z.enum(['console', 'fcm']).default('console'),

    MARKET_DATA_PROVIDER: z.enum(['mock', 'real']).default('mock'),
    MARKET_DATA_VENDOR: z.string().optional(),
    MARKET_DATA_API_KEY: z.string().optional(),
    MARKET_DATA_BASE_URL: z.string().url().optional(),

    SIGNAL_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
    SIGNAL_DEFAULT_TIMEFRAME: TimeframeSchema.default('5m'),
    SIGNAL_CANDLE_LOOKBACK: z.coerce.number().int().min(60).max(5000).default(250),
    /** Max symbols fetched concurrently per cycle - keep under your vendor's rate limit. */
    SIGNAL_FETCH_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_MODE === 'dev') {
        ctx.addIssue({ code: 'custom', path: ['AUTH_MODE'], message: 'AUTH_MODE=dev is not allowed in production' });
      }
      if (env.CORS_ORIGINS.trim() === '*') {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'Set explicit CORS origins in production' });
      }
    }
    const needsFirebase = env.AUTH_MODE === 'firebase' || env.NOTIFICATION_DRIVER === 'fcm';
    if (needsFirebase && !env.FIREBASE_PROJECT_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['FIREBASE_PROJECT_ID'],
        message: 'FIREBASE_PROJECT_ID is required when AUTH_MODE=firebase or NOTIFICATION_DRIVER=fcm',
      });
    }
    if (env.MARKET_DATA_PROVIDER === 'real' && !env.MARKET_DATA_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['MARKET_DATA_API_KEY'], message: 'Required when MARKET_DATA_PROVIDER=real' });
    }
  });

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
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
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
