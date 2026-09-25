import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RecordingNotificationSender } from '@signals/notifications';
import { NOW, auth, makeApp, prisma, resetDatabase } from './helpers';

let app: FastifyInstance;
let notifier: RecordingNotificationSender;

beforeAll(async () => {
  ({ app, notifier } = await makeApp());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(prisma);
  notifier.sent.length = 0;
});

const addTicker = (symbol: string, email?: string) =>
  app.inject({ method: 'POST', url: '/watchlist', headers: auth(email), payload: { symbol } });

describe('system & auth', () => {
  it('GET /health is public', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', database: 'ok', marketData: 'mock' });
  });

  it('rejects missing and malformed tokens', async () => {
    expect((await app.inject({ method: 'GET', url: '/watchlist' })).statusCode).toBe(401);
    const bad = await app.inject({
      method: 'GET',
      url: '/watchlist',
      headers: { authorization: 'Bearer not-a-token' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired token' });
  });

  it('provisions the user with default settings on first request', async () => {
    const res = await app.inject({ method: 'GET', url: '/me', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      email: 'alice@example.com',
      settings: { alertsEnabled: true, disabledCategories: [], timezone: 'UTC', notificationFrequency: 'REALTIME' },
    });
  });

  it('serves the OpenAPI document', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const paths = Object.keys(res.json().paths);
    for (const p of ['/watchlist', '/watchlist/{symbol}', '/assets/{symbol}', '/assets/{symbol}/signals', '/signals', '/signals/{id}', '/signal-events', '/devices/register']) {
      expect(paths).toContain(p);
    }
  });
});

describe('watchlist', () => {
  it('adds, lists with quotes, and removes tickers', async () => {
    const created = await addTicker('nvda');
    expect(created.statusCode).toBe(201);
    expect(created.json().item).toMatchObject({ symbol: 'NVDA', name: 'NVIDIA Corporation', assetClass: 'EQUITY', alertsEnabled: true });

    expect((await addTicker('NVDA')).statusCode).toBe(200); // idempotent
    await addTicker('AAPL');

    const list = await app.inject({ method: 'GET', url: '/watchlist', headers: auth() });
    const items = list.json().items;
    expect(items.map((i: { symbol: string }) => i.symbol)).toEqual(['NVDA', 'AAPL']);
    expect(items[0].quote).toMatchObject({ symbol: 'NVDA', source: 'mock', timestamp: new Date(NOW).toISOString() });
    expect(typeof items[0].quote.price).toBe('number');
    expect(typeof items[0].quote.changePercent).toBe('number');

    const del = await app.inject({ method: 'DELETE', url: '/watchlist/NVDA', headers: auth() });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: '/watchlist/NVDA', headers: auth() })).statusCode).toBe(404);
    const after = await app.inject({ method: 'GET', url: '/watchlist', headers: auth() });
    expect(after.json().items.map((i: { symbol: string }) => i.symbol)).toEqual(['AAPL']);
  });

  it('validates symbols and rejects unknown tickers', async () => {
    const invalid = await addTicker('NV DA; DROP');
    expect(invalid.statusCode).toBe(400);
    const unknown = await addTicker('ZZZZ');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().message).toMatch(/Unknown symbol/);
  });

  it('isolates users from each other', async () => {
    await addTicker('NVDA', 'alice@example.com');
    const bob = await app.inject({ method: 'GET', url: '/watchlist', headers: auth('bob@example.com') });
    expect(bob.json().items).toEqual([]);
  });

  it('toggles per-ticker alerts', async () => {
    await addTicker('NVDA');
    const res = await app.inject({ method: 'PATCH', url: '/watchlist/NVDA', headers: auth(), payload: { alertsEnabled: false } });
    expect(res.statusCode).toBe(204);
    const list = await app.inject({ method: 'GET', url: '/watchlist', headers: auth() });
    expect(list.json().items[0].alertsEnabled).toBe(false);
  });
});

describe('assets', () => {
  it('searches symbols', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/search?q=nv', headers: auth() });
    expect(res.json().results[0].symbol).toBe('NVDA');
    expect((await app.inject({ method: 'GET', url: '/assets/search?q=', headers: auth() })).statusCode).toBe(400);
  });

  it('returns detail with server-computed indicators on completed candles', async () => {
    await addTicker('NVDA');
    const res = await app.inject({ method: 'GET', url: '/assets/NVDA', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.asset.symbol).toBe('NVDA');
    expect(body.timeframe).toBe('5m');
    expect(body.inWatchlist).toBe(true);
    // 14:37:30 -> the 14:35 candle is in progress; last completed is 14:30
    expect(body.indicatorsAsOf).toBe(new Date(Date.UTC(2026, 8, 25, 14, 30)).toISOString());
    for (const k of ['ema9', 'ema20', 'ema21', 'ema50', 'rsi14', 'macd', 'macdSignal', 'volume', 'avgVolume20']) {
      expect(typeof body.indicators[k]).toBe('number');
    }
    expect(body.recentEvents).toEqual([]);
  });

  it('404s unknown assets', async () => {
    expect((await app.inject({ method: 'GET', url: '/assets/NOPE', headers: auth() })).statusCode).toBe(404);
  });
});

describe('signals', () => {
  it('subscribes new watchlist tickers to presets (default set enabled)', async () => {
    await addTicker('NVDA');
    const res = await app.inject({ method: 'GET', url: '/assets/NVDA/signals', headers: auth() });
    const signals = res.json().signals as { name: string; enabled: boolean; isPreset: boolean; timeframe: string }[];
    expect(signals).toHaveLength(15);
    expect(signals.every((s) => s.isPreset && s.timeframe === '5m')).toBe(true);
    expect(signals.filter((s) => s.enabled).map((s) => s.name)).toEqual([
      'EMA 9/21 Bullish Cross',
      'EMA 9/21 Bearish Cross',
      'RSI 14 crosses up through 30',
      'RSI 14 crosses down through 70',
      'MACD (12,26,9) Bullish Cross',
      'MACD (12,26,9) Bearish Cross',
      'Volume > 2x 20-period average',
    ]);
  });

  it('shares preset definitions between users', async () => {
    await addTicker('NVDA', 'alice@example.com');
    await addTicker('NVDA', 'bob@example.com');
    expect(await prisma.signalDefinition.count()).toBe(15);
    expect(await prisma.signalSubscription.count()).toBe(30);
  });

  it('toggles presets but refuses to edit or delete them', async () => {
    await addTicker('NVDA');
    const [first] = (await app.inject({ method: 'GET', url: '/signals', headers: auth() })).json().signals;
    const off = await app.inject({ method: 'PATCH', url: `/signals/${first.id}`, headers: auth(), payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json().enabled).toBe(false);
    const edit = await app.inject({ method: 'PATCH', url: `/signals/${first.id}`, headers: auth(), payload: { parameters: { fast: 5, slow: 10 } } });
    expect(edit.statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/signals/${first.id}`, headers: auth() })).statusCode).toBe(409);
  });

  it('creates, edits and deletes custom signals with validated parameters', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/signals',
      headers: auth(),
      payload: { ticker: 'NVDA', signalType: 'PRICE_ABOVE', parameters: { threshold: 190 } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Price above $190.00', isPreset: false, enabled: true, category: 'PRICE', timeframe: '5m' });

    const bad = await app.inject({
      method: 'POST',
      url: '/signals',
      headers: auth(),
      payload: { ticker: 'NVDA', signalType: 'EMA_BULLISH_CROSS', parameters: { fast: 50, slow: 20 } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/fast period must be shorter/);

    const missing = await app.inject({ method: 'POST', url: '/signals', headers: auth(), payload: { ticker: 'NVDA', signalType: 'PRICE_BELOW' } });
    expect(missing.statusCode).toBe(400);

    const id = created.json().id;
    const edited = await app.inject({ method: 'PATCH', url: `/signals/${id}`, headers: auth(), payload: { parameters: { threshold: 200 } } });
    expect(edited.json()).toMatchObject({ name: 'Price above $200.00', parameters: { threshold: 200 } });

    // other users cannot see or touch it
    expect((await app.inject({ method: 'PATCH', url: `/signals/${id}`, headers: auth('bob@example.com'), payload: { enabled: false } })).statusCode).toBe(404);

    expect((await app.inject({ method: 'DELETE', url: `/signals/${id}`, headers: auth() })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/signals', headers: auth() })).json().signals).toEqual([]);
  });

  it('exposes the signal catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/signals/catalog', headers: auth() });
    expect(res.json().catalog).toHaveLength(16);
  });
});

describe('signal events', () => {
  async function seedEvents(email: string, n: number) {
    await addTicker('NVDA', email);
    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    const def = await prisma.signalDefinition.findFirstOrThrow({ where: { signalType: 'EMA_BULLISH_CROSS', ticker: 'NVDA' } });
    for (let i = 0; i < n; i++) {
      await prisma.signalEvent.create({
        data: {
          userId: user.id,
          signalDefinitionId: def.id,
          ticker: 'NVDA',
          signalType: 'EMA_BULLISH_CROSS',
          category: 'MOVING_AVERAGE',
          name: def.name,
          timeframe: '5m',
          candleTime: new Date(NOW - (n - i) * 300_000),
          triggeredAt: new Date(NOW - (n - i) * 300_000 + 1000),
          price: 180 + i,
          values: { ema9: 181.9, ema21: 181.7, rsi14: 63.2 },
          message: `EMA 9 crossed above EMA 21 at $${180 + i}.00`,
          deliveryStatus: 'SENT',
        },
      });
    }
  }

  it('lists history newest first with cursor pagination and user isolation', async () => {
    await seedEvents('alice@example.com', 5);
    const page1 = await app.inject({ method: 'GET', url: '/signal-events?limit=3', headers: auth() });
    const body1 = page1.json();
    expect(body1.events.map((e: { price: number }) => e.price)).toEqual([184, 183, 182]);
    expect(body1.events[0]).toMatchObject({ ticker: 'NVDA', signalType: 'EMA_BULLISH_CROSS', values: { ema9: 181.9 } });
    expect(body1.nextCursor).toBe(body1.events[2].id);

    const page2 = await app.inject({ method: 'GET', url: `/signal-events?limit=3&before=${body1.nextCursor}`, headers: auth() });
    expect(page2.json().events.map((e: { price: number }) => e.price)).toEqual([181, 180]);
    expect(page2.json().nextCursor).toBeNull();

    const bob = await app.inject({ method: 'GET', url: '/signal-events', headers: auth('bob@example.com') });
    expect(bob.json().events).toEqual([]);

    const one = await app.inject({ method: 'GET', url: `/signal-events/${body1.events[0].id}`, headers: auth() });
    expect(one.json().message).toBe('EMA 9 crossed above EMA 21 at $184.00');
    expect((await app.inject({ method: 'GET', url: `/signal-events/${body1.events[0].id}`, headers: auth('bob@example.com') })).statusCode).toBe(404);
  });

  it('keeps history when the ticker is removed and shows recent events on the asset', async () => {
    await seedEvents('alice@example.com', 2);
    const detail = await app.inject({ method: 'GET', url: '/assets/NVDA', headers: auth() });
    expect(detail.json().recentEvents).toHaveLength(2);
    await app.inject({ method: 'DELETE', url: '/watchlist/NVDA', headers: auth() });
    expect((await app.inject({ method: 'GET', url: '/signal-events', headers: auth() })).json().events).toHaveLength(2);
  });
});

describe('devices & settings', () => {
  it('registers devices, moves re-registered tokens, and sends a test push', async () => {
    const token = 'fcm-token-abcdefghijklmnop';
    const reg = await app.inject({ method: 'POST', url: '/devices/register', headers: auth(), payload: { token, platform: 'android' } });
    expect(reg.statusCode).toBe(201);
    const test = await app.inject({ method: 'POST', url: '/devices/test', headers: auth() });
    expect(test.json()).toEqual({ devices: 1, delivered: 1 });
    expect(notifier.sent[0]!.targets[0]).toEqual({ token, provider: 'FCM', platform: 'android' });

    await app.inject({ method: 'POST', url: '/devices/register', headers: auth('bob@example.com'), payload: { token, platform: 'android' } });
    expect((await app.inject({ method: 'POST', url: '/devices/test', headers: auth() })).json().devices).toBe(0);

    const unreg = await app.inject({ method: 'POST', url: '/devices/unregister', headers: auth('bob@example.com'), payload: { token } });
    expect(unreg.statusCode).toBe(204);
    expect(await prisma.device.count()).toBe(0);
  });

  it('updates notification settings with validation', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/me/settings',
      headers: auth(),
      payload: { alertsEnabled: false, disabledCategories: ['VOLUME'], quietHoursStart: '22:00', timezone: 'Asia/Bangkok' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ alertsEnabled: false, disabledCategories: ['VOLUME'], quietHoursStart: '22:00', timezone: 'Asia/Bangkok' });
    const bad = await app.inject({ method: 'PATCH', url: '/me/settings', headers: auth(), payload: { quietHoursStart: '25h' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('rate limiting', () => {
  it('returns 429 after the configured number of requests', async () => {
    const { app: limited } = await makeApp({ RATE_LIMIT_MAX: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await limited.inject({ method: 'GET', url: '/health' })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    await limited.close();
  });
});
