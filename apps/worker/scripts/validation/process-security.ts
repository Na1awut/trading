/**
 * Process-level security validation (Phase 3, step 7).
 *
 *   pnpm build && pnpm --filter @signals/worker validate:security
 *
 * Runs the BUILT API and worker binaries against a real Postgres database
 * (VALIDATION_DATABASE_URL, default signals_validation) and checks:
 *
 *  1. Production guards: dev auth, wildcard CORS, mock market data, TRUST_PROXY=true and a
 *     real provider without a key all refuse to start.
 *  2. Secret hygiene: with a fake (but real-shaped) Twelve Data key, Firebase service
 *     account, bearer token and device token, no secret value appears in any log output,
 *     including the vendor network-failure path and the Firebase init path.
 *  3. Malformed input over real HTTP: symbols, timeframes, device tokens and payloads are
 *     rejected with 4xx, never 500, and error bodies carry no stack traces.
 *
 * All secrets used here are generated per run and are not valid credentials.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { addToWatchlist, createPrismaClient, findOrCreateUser } from '@signals/db';
import {
  API_BIN,
  Report,
  VALIDATION_DB_URL,
  WORKER_BIN,
  baseEnv,
  freePort,
  leakedSecrets,
  run,
  start,
} from './lib';

const report = new Report('Process-level security validation');
const hex = (n: number) => randomBytes(n).toString('hex');

const FAKE_VENDOR_KEY = `tdvalidation${hex(16)}`;
// A real, throwaway RSA key (not a credential for any Firebase project), so firebase-admin
// accepts the service account and the process boots like production would.
const { privateKey: FAKE_PRIVATE_KEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const FAKE_PRIVATE_KEY_BODY = FAKE_PRIVATE_KEY_PEM.split('\n')[5]!;
const FAKE_PRIVATE_KEY_ID = `pkid${hex(12)}`;
const serviceAccount = (privateKey: string) =>
  Buffer.from(
    JSON.stringify({
      type: 'service_account',
      project_id: 'signals-validation-fake',
      private_key_id: FAKE_PRIVATE_KEY_ID,
      private_key: privateKey,
      client_email: 'validation@signals-validation-fake.iam.gserviceaccount.com',
      client_id: '1234567890',
    }),
  ).toString('base64');
const FAKE_SERVICE_ACCOUNT_B64 = serviceAccount(FAKE_PRIVATE_KEY_PEM);
const UNPARSEABLE_KEY_BODY = `MIIEunparseable${hex(16)}`;
const UNPARSEABLE_SERVICE_ACCOUNT_B64 = serviceAccount(
  `-----BEGIN PRIVATE KEY-----\n${UNPARSEABLE_KEY_BODY}\n-----END PRIVATE KEY-----\n`,
);
const FAKE_BEARER = `eyJhbGciOiJSUzI1NiJ9.${hex(24)}.${hex(24)}`;
const DEV_EMAIL = `leakcheck-${hex(6)}@example.com`;
const DEVICE_TOKEN = `fcmvalidation:${hex(40)}`;

const SECRETS = {
  MARKET_DATA_API_KEY: FAKE_VENDOR_KEY,
  FIREBASE_SERVICE_ACCOUNT_BASE64: FAKE_SERVICE_ACCOUNT_B64,
  'service account private_key': FAKE_PRIVATE_KEY_BODY,
  'service account private_key_id': FAKE_PRIVATE_KEY_ID,
  'unparseable service account': UNPARSEABLE_SERVICE_ACCOUNT_B64,
  'unparseable private_key': UNPARSEABLE_KEY_BODY,
  'Authorization bearer token': FAKE_BEARER,
  'dev bearer token (email)': DEV_EMAIL,
  'device push token': DEVICE_TOKEN,
};

const PROD_OK = {
  NODE_ENV: 'production',
  AUTH_MODE: 'firebase',
  FIREBASE_PROJECT_ID: 'signals-validation-fake',
  FIREBASE_SERVICE_ACCOUNT_BASE64: FAKE_SERVICE_ACCOUNT_B64,
  CORS_ORIGINS: 'https://app.example.com',
  MARKET_DATA_PROVIDER: 'real',
  MARKET_DATA_VENDOR: 'twelvedata',
  MARKET_DATA_API_KEY: FAKE_VENDOR_KEY,
  NOTIFICATION_DRIVER: 'console',
  TRUST_PROXY: '1',
};

async function productionGuards() {
  const cases: { name: string; env: Record<string, string>; expect: RegExp }[] = [
    { name: 'AUTH_MODE=dev', env: { AUTH_MODE: 'dev' }, expect: /AUTH_MODE/ },
    { name: 'CORS_ORIGINS=*', env: { CORS_ORIGINS: '*' }, expect: /CORS_ORIGINS/ },
    {
      name: 'MARKET_DATA_PROVIDER=mock',
      env: { MARKET_DATA_PROVIDER: 'mock' },
      expect: /MARKET_DATA_PROVIDER/,
    },
    { name: 'TRUST_PROXY=true', env: { TRUST_PROXY: 'true' }, expect: /TRUST_PROXY/ },
    {
      name: 'real provider without MARKET_DATA_API_KEY',
      env: { MARKET_DATA_API_KEY: '' },
      expect: /MARKET_DATA_API_KEY/,
    },
    {
      name: 'AUTH_MODE=firebase without FIREBASE_PROJECT_ID',
      env: { FIREBASE_PROJECT_ID: '' },
      expect: /FIREBASE_PROJECT_ID/,
    },
  ];
  for (const bin of [
    ['api', API_BIN],
    ['worker', WORKER_BIN],
  ] as const) {
    for (const c of cases) {
      const env = baseEnv({ ...PROD_OK, ...c.env });
      for (const [k, v] of Object.entries(env)) if (v === '') delete env[k];
      const r = await run(bin[1], ['--once'], env, 30_000);
      const leaks = leakedSecrets(r.output, SECRETS);
      report.check(
        'production guards',
        `${bin[0]} refuses ${c.name}`,
        r.code !== 0 && !r.timedOut && c.expect.test(r.output) && leaks.length === 0,
        `exit=${r.code}${r.timedOut ? ' (timed out: process kept running)' : ''}${leaks.length ? ` LEAKED: ${leaks.join(', ')}` : ''}`,
      );
    }
  }
}

async function firebaseInitPath() {
  for (const bin of [
    ['api', API_BIN],
    ['worker', WORKER_BIN],
  ] as const) {
    const bad = await run(
      bin[1],
      ['--once'],
      baseEnv({
        ...PROD_OK,
        NOTIFICATION_DRIVER: 'fcm',
        FIREBASE_SERVICE_ACCOUNT_BASE64: UNPARSEABLE_SERVICE_ACCOUNT_B64,
        API_PORT: String(await freePort()),
      }),
      30_000,
    );
    const leaks = leakedSecrets(bad.output, SECRETS);
    report.check(
      'secret hygiene',
      `${bin[0]} fails fast on an unparseable service account without echoing it`,
      bad.code !== 0 &&
        !bad.timedOut &&
        /private key|credential/i.test(bad.output) &&
        leaks.length === 0,
      `exit=${bad.code}${leaks.length ? `; LEAKED: ${leaks.join(', ')}` : ''}`,
    );
  }

  // A production-shaped config with a syntactically valid but fake service account.
  const port = await freePort();
  const api = start(API_BIN, [], baseEnv({ ...PROD_OK, API_PORT: String(port) }));
  const listening = await api.waitFor(/Server listening|listening/i, 20_000);
  let detail = listening ? 'booted' : `did not boot: ${api.output().split('\n')[0]?.slice(0, 120)}`;
  report.check(
    'auth',
    'production API boots with a well-formed service account',
    listening,
    detail,
  );
  if (listening) {
    const res = await fetch(`http://127.0.0.1:${port}/me`, {
      headers: { authorization: `Bearer ${FAKE_BEARER}` },
    });
    detail += `; GET /me with a forged bearer -> ${res.status}`;
    report.check(
      'auth',
      'production API rejects a forged Firebase ID token',
      res.status === 401,
      `status=${res.status}`,
    );
    const dev = await fetch(`http://127.0.0.1:${port}/me`, {
      headers: { authorization: `Bearer dev:${DEV_EMAIL}` },
    });
    report.check(
      'auth',
      'production API rejects a dev-mode token',
      dev.status === 401,
      `status=${dev.status}`,
    );
  }
  await api.stop();
  const leaks = leakedSecrets(api.output(), SECRETS);
  report.check(
    'secret hygiene',
    'API (production, fake Firebase service account) logs contain no secrets',
    leaks.length === 0,
    `${detail}; ${api.output().split('\n').length} log lines${leaks.length ? `; LEAKED: ${leaks.join(', ')}` : ''}`,
  );
}

async function vendorFailurePath() {
  // Real provider with a fake key: the vendor call fails (egress blocked, or 401 upstream).
  const port = await freePort();
  const api = start(
    API_BIN,
    [],
    baseEnv({
      NODE_ENV: 'development',
      AUTH_MODE: 'dev',
      MARKET_DATA_PROVIDER: 'real',
      MARKET_DATA_VENDOR: 'twelvedata',
      MARKET_DATA_API_KEY: FAKE_VENDOR_KEY,
      MARKET_DATA_MAX_RETRIES: '1',
      MARKET_DATA_TIMEOUT_MS: '5000',
      API_PORT: String(port),
    }),
  );
  if (!(await api.waitFor(/listening/i))) {
    report.check('secret hygiene', 'API (real provider, fake key) boots', false, api.output());
    await api.stop();
    return;
  }
  const auth = { authorization: `Bearer dev:${DEV_EMAIL}` };
  const statuses: string[] = [];
  for (const path of [
    '/assets/search?q=AAPL',
    '/assets/AAPL',
    '/assets/AAPL/candles?timeframe=5m',
  ]) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: auth });
    const body = await res.text();
    statuses.push(`${path} -> ${res.status}`);
    const leaks = leakedSecrets(body, SECRETS);
    report.check(
      'secret hygiene',
      `vendor failure on ${path} is a 502/503 with no secrets in the body`,
      leaks.length === 0 && (res.status === 502 || res.status === 503),
      `status=${res.status}${leaks.length ? ` LEAKED: ${leaks.join(', ')}` : ''}`,
    );
  }
  const reg = await fetch(`http://127.0.0.1:${port}/devices/register`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ token: DEVICE_TOKEN, platform: 'android' }),
  });
  statuses.push(`/devices/register -> ${reg.status}`);
  await api.stop();
  const out = api.output();
  const leaks = leakedSecrets(out, SECRETS);
  const vendorErrors = (out.match(/"code":"[A-Z_]+"/g) ?? []).slice(0, 5).join(' ');
  report.check(
    'secret hygiene',
    'API logs on the vendor failure path contain no secrets',
    leaks.length === 0 && /market data|vendor|twelvedata/i.test(out),
    `${statuses.join('; ')}; vendor error codes seen: ${vendorErrors || 'none'}${leaks.length ? `; LEAKED: ${leaks.join(', ')}` : ''}`,
  );

  // Worker with the same fake key and one real subscription to evaluate.
  const prisma = createPrismaClient(VALIDATION_DB_URL);
  const user = await findOrCreateUser(prisma, { firebaseUid: 'validation:security', email: null });
  await addToWatchlist(prisma, {
    userId: user.id,
    asset: {
      symbol: 'AAPL',
      name: 'Apple Inc.',
      assetClass: 'EQUITY',
      exchange: 'NASDAQ',
      currency: 'USD',
    },
    timeframe: '5m',
  });
  await prisma.$disconnect();
  const worker = await run(
    WORKER_BIN,
    ['--once'],
    baseEnv({
      NODE_ENV: 'development',
      LOG_LEVEL: 'debug',
      MARKET_DATA_PROVIDER: 'real',
      MARKET_DATA_VENDOR: 'twelvedata',
      MARKET_DATA_API_KEY: FAKE_VENDOR_KEY,
      MARKET_DATA_MAX_RETRIES: '1',
      MARKET_DATA_TIMEOUT_MS: '5000',
      NOTIFICATION_DRIVER: 'fcm',
      FIREBASE_PROJECT_ID: 'signals-validation-fake',
      FIREBASE_SERVICE_ACCOUNT_BASE64: FAKE_SERVICE_ACCOUNT_B64,
    }),
    90_000,
  );
  const wleaks = leakedSecrets(worker.output, SECRETS);
  report.check(
    'secret hygiene',
    'worker logs (real provider fake key, FCM fake service account, debug level) contain no secrets',
    wleaks.length === 0 && !worker.timedOut,
    `exit=${worker.code}; ${worker.output.split('\n').length} log lines${wleaks.length ? `; LEAKED: ${wleaks.join(', ')}` : ''}`,
  );
}

async function malformedInput() {
  const port = await freePort();
  const api = start(
    API_BIN,
    [],
    baseEnv({
      NODE_ENV: 'development',
      AUTH_MODE: 'dev',
      MARKET_DATA_PROVIDER: 'mock',
      API_PORT: String(port),
      RATE_LIMIT_MAX: '100000',
    }),
  );
  if (!(await api.waitFor(/listening/i))) {
    report.check('malformed input', 'API boots', false, api.output().slice(-500));
    await api.stop();
    return;
  }
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: 'Bearer dev:malformed@example.com' };
  const json = { ...auth, 'content-type': 'application/json' };
  const long = (n: number) => 'A'.repeat(n);
  type Case = [string, string, RequestInit & { headers?: Record<string, string> }, number[]];
  const cases: Case[] = [
    ['path traversal symbol', '/assets/..%2F..%2Fetc%2Fpasswd', { headers: auth }, [400, 404]],
    [
      'SQL-ish symbol',
      `/assets/${encodeURIComponent("AAPL';DROP TABLE users;--")}`,
      { headers: auth },
      [400],
    ],
    // Fastify caps path parameters at 100 chars and answers 414 before routing.
    ['over-long symbol', `/assets/${long(200)}`, { headers: auth }, [400, 414]],
    ['unicode symbol', `/assets/${encodeURIComponent('ÄPPL')}`, { headers: auth }, [400]],
    ['NUL byte symbol', '/assets/AA%00PL', { headers: auth }, [400]],
    ['unknown timeframe 2m', '/assets/AAPL/candles?timeframe=2m', { headers: auth }, [400]],
    [
      'timeframe injection',
      `/assets/AAPL/candles?timeframe=${encodeURIComponent('5m;1=1')}`,
      { headers: auth },
      [400],
    ],
    ['limit out of range', '/assets/AAPL/candles?limit=100000', { headers: auth }, [400]],
    ['limit negative', '/assets/AAPL/candles?limit=-5', { headers: auth }, [400]],
    [
      'watchlist bad symbol',
      '/watchlist',
      { method: 'POST', headers: json, body: JSON.stringify({ symbol: '<script>' }) },
      [400],
    ],
    [
      'watchlist non-JSON body',
      '/watchlist',
      { method: 'POST', headers: json, body: '{symbol:AAPL' },
      [400],
    ],
    [
      'watchlist wrong content type',
      '/watchlist',
      { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: 'AAPL' },
      [400, 415],
    ],
    ['watchlist array body', '/watchlist', { method: 'POST', headers: json, body: '[]' }, [400]],
    [
      'watchlist __proto__ payload',
      '/watchlist',
      { method: 'POST', headers: json, body: '{"__proto__":{"admin":true},"symbol":"AAPL"}' },
      [201, 200, 400],
    ],
    [
      'oversized body (200 KB)',
      '/watchlist',
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ symbol: 'AAPL', pad: long(200_000) }),
      },
      [413],
    ],
    [
      'device token too short',
      '/devices/register',
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ token: 'abc', platform: 'android' }),
      },
      [400],
    ],
    [
      'device token with spaces/quotes',
      '/devices/register',
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ token: 'abc def "ghi" jkl', platform: 'android' }),
      },
      [400],
    ],
    [
      'device token 5000 chars',
      '/devices/register',
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ token: long(5000), platform: 'android' }),
      },
      [400],
    ],
    [
      'device token wrong type',
      '/devices/register',
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ token: 12345678901, platform: 'android' }),
      },
      [400],
    ],
    [
      'device bad platform',
      '/devices/register',
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ token: 'valid-token-123456', platform: 'symbian' }),
      },
      [400],
    ],
    [
      'device bad provider',
      '/devices/register',
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ token: 'valid-token-123456', platform: 'android', provider: 'SMS' }),
      },
      [400],
    ],
    [
      'signal unknown type',
      '/signals',
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ ticker: 'AAPL', signalType: 'MOON' }),
      },
      [400],
    ],
    [
      'signal bad timeframe',
      '/signals',
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ ticker: 'AAPL', signalType: 'EMA_BULLISH_CROSS', timeframe: '7m' }),
      },
      [400],
    ],
    [
      'signal absurd parameters',
      '/signals',
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          ticker: 'AAPL',
          signalType: 'RSI_OVERSOLD',
          parameters: { period: -1, threshold: 1e9 },
        }),
      },
      [400],
    ],
    [
      'settings bad timezone',
      '/me/settings',
      { method: 'PATCH', headers: json, body: JSON.stringify({ timezone: 'Mars/Olympus' }) },
      [400],
    ],
    [
      'settings bad quiet hours',
      '/me/settings',
      { method: 'PATCH', headers: json, body: JSON.stringify({ quietHoursStart: '25:99' }) },
      [400],
    ],
    ['event id too long', `/signal-events/${long(300)}`, { headers: auth }, [400, 414]],
    ['event id 80 chars', `/signal-events/${long(80)}`, { headers: auth }, [400]],
    ['event id unknown', '/signal-events/does-not-exist', { headers: auth }, [404]],
    ['no auth header', '/watchlist', {}, [401]],
    [
      'malformed auth header',
      '/watchlist',
      { headers: { authorization: 'Basic Zm9vOmJhcg==' } },
      [401],
    ],
    [
      'dev token with bad email',
      '/watchlist',
      { headers: { authorization: 'Bearer dev:not-an-email' } },
      [401],
    ],
  ];
  let serverErrors = 0;
  for (const [name, path, init, expected] of cases) {
    let status = 0;
    let body = '';
    try {
      const res = await fetch(base + path, init);
      status = res.status;
      body = await res.text();
    } catch (err) {
      body = String(err);
    }
    if (status >= 500) serverErrors++;
    const stack = /\bat [\w.<>]+ \(|node_modules|\.ts:\d+|\.js:\d+/.test(body);
    report.check(
      'malformed input',
      name,
      expected.includes(status) && !stack,
      `status=${status} (expected ${expected.join('/')})${stack ? ' STACK TRACE IN BODY' : ''}`,
    );
  }
  await api.stop();
  const out = api.output();
  const fivexx = (out.match(/"statusCode":5\d\d/g) ?? []).length;
  report.check(
    'malformed input',
    'no 5xx responses and no 5xx in API logs',
    serverErrors === 0 && fivexx === 0,
    `responses=${serverErrors}, logs=${fivexx}`,
  );
}

async function main() {
  await productionGuards();
  await firebaseInitPath();
  await vendorFailurePath();
  await malformedInput();
  report.note(
    'Secrets are generated per run and are not valid credentials. The vendor failure path reflects this environment (egress to the vendor may be blocked), not live Twelve Data behaviour.',
  );
  report.write('security');
  console.info(`\n${report.checks.length - report.failed}/${report.checks.length} checks passed`);
  process.exit(report.failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
