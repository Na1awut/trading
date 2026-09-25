import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { LOG_REDACT_PATHS, parseConfig } from '@signals/config';
import type { PrismaClient } from '@signals/db';
import { MockMarketDataProvider } from '@signals/market-data';
import { RecordingNotificationSender } from '@signals/notifications';
import { buildApp } from '../src/app';
import { DevAuthVerifier } from '../src/plugins/auth';
import { DATABASE_URL, auth, makeApp, prisma, resetDatabase } from './helpers';

afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));

describe('health and readiness', () => {
  it('reports not ready (503) when the database is unreachable, while /health stays up', async () => {
    // Standalone stub (never mutate the shared client: Prisma's proxy would write through).
    const brokenDb = {
      $queryRaw: () => Promise.reject(new Error("Can't reach database server")),
    } as unknown as PrismaClient;
    const app = await buildApp(
      {
        config: parseConfig({ DATABASE_URL, LOG_LEVEL: 'silent' }),
        prisma: brokenDb,
        marketData: new MockMarketDataProvider(),
        notifier: new RecordingNotificationSender(),
        authVerifier: new DevAuthVerifier(),
      },
      { logger: false },
    );
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({
      status: 'not_ready',
      checks: { database: { status: 'fail' }, config: { status: 'ok' } },
    });
    await app.close();
  });

  it('does not depend on the market-data vendor', async () => {
    const vendorDown = new MockMarketDataProvider();
    vendorDown.getQuote = async () => {
      throw new Error('vendor down');
    };
    const { app } = await makeApp({}, { marketData: vendorDown });
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('request ids and logging', () => {
  async function appWithLogs() {
    const lines: string[] = [];
    const logger = pino(
      { level: 'info', redact: LOG_REDACT_PATHS },
      { write: (l: string) => void lines.push(l) },
    );
    const app = await buildApp(
      {
        config: parseConfig({ DATABASE_URL }),
        prisma,
        marketData: new MockMarketDataProvider(),
        notifier: new RecordingNotificationSender(),
        authVerifier: new DevAuthVerifier(),
      },
      { logger },
    );
    return { app, lines };
  }

  it('returns an x-request-id and tags every request log line with it', async () => {
    const { app, lines } = await appWithLogs();
    const res = await app.inject({ method: 'GET', url: '/health' });
    const id = res.headers['x-request-id'] as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const tagged = lines.map((l) => JSON.parse(l)).filter((l) => l.requestId === id);
    expect(tagged.map((l) => l.msg)).toEqual(['incoming request', 'request completed']);
    await app.close();
  });

  it('propagates a well-formed incoming request id and replaces a malformed one', async () => {
    const { app } = await appWithLogs();
    const good = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'lb-7f3a9c21-abc' },
    });
    expect(good.headers['x-request-id']).toBe('lb-7f3a9c21-abc');
    const bad = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'x\ninjected log line' },
    });
    expect(bad.headers['x-request-id']).not.toContain('injected');
    await app.close();
  });

  it('redacts secrets even if a log statement includes them', () => {
    const lines: string[] = [];
    const log = pino({ redact: LOG_REDACT_PATHS }, { write: (l: string) => void lines.push(l) });
    log.info({
      req: { headers: { authorization: 'Bearer eyJhbGciOi.secret' } },
      provider: { apiKey: 'td-secret-key' },
      device: { token: 'fcm-device-token' },
      serviceAccount: { private_key: '-----BEGIN PRIVATE KEY-----' },
    });
    const out = lines.join('');
    for (const secret of [
      'eyJhbGciOi.secret',
      'td-secret-key',
      'fcm-device-token',
      'BEGIN PRIVATE KEY',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[Redacted]');
  });
});

describe('API docs availability', () => {
  it('can be disabled (default in production)', async () => {
    const { app } = await makeApp({ ENABLE_API_DOCS: 'false' });
    expect((await app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
    await app.close();
  });
});

describe('rate limiting cannot be bypassed', () => {
  const hit = (app: Awaited<ReturnType<typeof makeApp>>['app'], headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/signals/catalog', headers });

  it('keys on client IP, so rotating bearer tokens does not reset the limit', async () => {
    const { app } = await makeApp({ RATE_LIMIT_MAX: '3' });
    const codes = [];
    for (let i = 0; i < 4; i++)
      codes.push((await hit(app, auth(`user${i}@example.com`))).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    await app.close();
  });

  it('ignores spoofed X-Forwarded-For unless TRUST_PROXY is configured', async () => {
    const { app } = await makeApp({ RATE_LIMIT_MAX: '2' });
    const codes = [];
    for (let i = 0; i < 3; i++)
      codes.push((await hit(app, { ...auth(), 'x-forwarded-for': `203.0.113.${i}` })).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    await app.close();

    const { app: behindLb } = await makeApp({ RATE_LIMIT_MAX: '2', TRUST_PROXY: '1' });
    const lbCodes = [];
    for (let i = 0; i < 3; i++)
      lbCodes.push(
        (await hit(behindLb, { ...auth(), 'x-forwarded-for': `203.0.113.${i}` })).statusCode,
      );
    expect(lbCodes).toEqual([200, 200, 200]); // distinct real clients behind one trusted proxy
    await behindLb.close();
  });
});

describe('input validation', () => {
  it('rejects malformed push tokens and search queries', async () => {
    const { app } = await makeApp();
    const badToken = await app.inject({
      method: 'POST',
      url: '/devices/register',
      headers: auth(),
      payload: { token: 'abc<script>alert(1)</script>', platform: 'android' },
    });
    expect(badToken.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'POST',
      url: '/devices/register',
      headers: auth(),
      payload: { token: 'fGx9-abc:APA91bH_valid-token', platform: 'android' },
    });
    expect(ok.statusCode).toBe(201);
    expect(
      (await app.inject({ method: 'GET', url: '/assets/search?q=%3Cscript%3E', headers: auth() }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/assets/search?q=PTT', headers: auth() }))
        .statusCode,
    ).toBe(200);
    await app.close();
  });
});

describe('GET /metrics', () => {
  it('does not exist unless METRICS_TOKEN is configured', async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    await app.close();
  });

  it('requires the metrics token and reports cache hits/misses and requests', async () => {
    const { Metrics } = await import('@signals/config');
    const { CachedMarketDataProvider } = await import('@signals/market-data');
    const metrics = new Metrics();
    const marketData = new CachedMarketDataProvider(new MockMarketDataProvider(), {
      onCacheResult: (kind, hit) =>
        metrics.inc(hit ? 'market_data_cache_hits_total' : 'market_data_cache_misses_total', {
          kind,
        }),
    });
    const app = await buildApp(
      {
        config: parseConfig({
          DATABASE_URL,
          LOG_LEVEL: 'silent',
          METRICS_TOKEN: 'metrics-token-0123456789',
        }),
        prisma,
        marketData,
        notifier: new RecordingNotificationSender(),
        authVerifier: new DevAuthVerifier(),
        metrics,
      },
      { logger: false },
    );
    await app.inject({
      method: 'POST',
      url: '/watchlist',
      headers: auth(),
      payload: { symbol: 'NVDA' },
    });
    await app.inject({ method: 'GET', url: '/watchlist', headers: auth() });
    await app.inject({ method: 'GET', url: '/watchlist', headers: auth() });

    expect((await app.inject({ method: 'GET', url: '/metrics', headers: auth() })).statusCode).toBe(
      401,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-token-0123456789' },
    });
    expect(res.statusCode).toBe(200);
    const { counters } = res.json();
    expect(counters['market_data_cache_misses_total{kind="quote"}']).toBe(1);
    expect(counters['market_data_cache_hits_total{kind="quote"}']).toBe(2);
    expect(counters['http_requests_total{route="/watchlist",status="2xx"}']).toBe(3);
    await app.close();
  });
});
