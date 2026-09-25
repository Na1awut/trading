import { describe, expect, it } from 'vitest';
import {
  MarketDataError,
  ProviderNotConfiguredError,
  RealMarketDataProvider,
  TokenBucketRateLimiter,
  UnknownSymbolError,
  resolveBaseUrl,
  type RealProviderOptions,
} from '../src';
import { captureLogger, fakeFetch, fixture, type Reply } from './helpers';

const KEY = 'td-secret-key-123456';

function provider(replies: Reply[], extra: Partial<RealProviderOptions> = {}) {
  const f = fakeFetch(replies);
  const log = captureLogger();
  const sleeps: number[] = [];
  const p = new RealMarketDataProvider({
    vendor: 'twelvedata',
    apiKey: KEY,
    maxRetries: 3,
    timeoutMs: 50,
    requestsPerMinute: 1000,
    fetch: f.fetch,
    logger: log.logger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...extra,
  });
  return { p, urls: f.urls, log, sleeps };
}

describe('RealMarketDataProvider (Twelve Data) - normalisation', () => {
  it('normalises a quote: numbers from strings, UTC ISO timestamp, currency/exchange/session', async () => {
    const { p, urls } = provider([{ body: fixture('quote.json') }]);
    const q = await p.getQuote('NVDA');
    expect(q).toEqual({
      symbol: 'NVDA',
      price: 182.3,
      previousClose: 179.75,
      change: 2.55,
      changePercent: 1.41863,
      volume: 61_200_000,
      timestamp: '2026-09-25T14:00:00.000Z', // unix 1790344800
      currency: 'USD',
      exchange: 'NASDAQ',
      marketOpen: true,
      delayed: true,
      source: 'twelvedata',
    });
    expect(urls[0]!.pathname).toBe('/quote');
    expect(urls[0]!.searchParams.get('symbol')).toBe('NVDA');
  });

  it('normalises intraday candles: ascending, UTC, tagged with symbol and timeframe', async () => {
    const { p, urls } = provider([{ body: fixture('time_series_5min.json') }]);
    const candles = await p.getHistoricalCandles('NVDA', '5m', 3);
    expect(candles.map((c) => c.timestamp)).toEqual([
      '2026-09-25T14:30:00.000Z',
      '2026-09-25T14:35:00.000Z',
      '2026-09-25T14:40:00.000Z',
    ]);
    expect(candles[0]).toEqual({
      symbol: 'NVDA',
      timeframe: '5m',
      time: Date.UTC(2026, 8, 25, 14, 30),
      timestamp: '2026-09-25T14:30:00.000Z',
      open: 181.7,
      high: 182,
      low: 181.6,
      close: 181.9,
      volume: 402_000,
    });
    const q = urls[0]!.searchParams;
    expect(urls[0]!.pathname).toBe('/time_series');
    expect([q.get('interval'), q.get('outputsize'), q.get('timezone'), q.get('order')]).toEqual([
      '5min',
      '3',
      'UTC',
      'asc',
    ]);
  });

  it('maps canonical symbols to vendor symbols (SET listings, crypto pairs) and daily dates to UTC', async () => {
    const { p, urls } = provider([
      { body: fixture('time_series_1day.json') },
      { body: { meta: { symbol: 'BTC/USD', interval: '1h' }, values: [] } },
    ]);
    const daily = await p.getHistoricalCandles('PTT.BK', '1d', 2);
    expect(urls[0]!.searchParams.get('symbol')).toBe('PTT');
    expect(urls[0]!.searchParams.get('exchange')).toBe('SET');
    expect(urls[0]!.searchParams.get('interval')).toBe('1day');
    expect(daily.map((c) => [c.symbol, c.timestamp, c.close])).toEqual([
      ['PTT.BK', '2026-09-24T00:00:00.000Z', 33.25],
      ['PTT.BK', '2026-09-25T00:00:00.000Z', 33.5],
    ]);
    await p.getHistoricalCandles('BTC-USD', '1h', 10);
    expect(urls[1]!.searchParams.get('symbol')).toBe('BTC/USD');
  });

  it('normalises symbol search: canonical symbols, supported venues and instrument types only', async () => {
    const { p } = provider([{ body: fixture('symbol_search.json') }]);
    const results = await p.searchSymbols('nv');
    expect(results).toEqual([
      {
        symbol: 'NVDA',
        name: 'NVIDIA Corp',
        assetClass: 'EQUITY',
        exchange: 'NASDAQ',
        currency: 'USD',
      },
      {
        symbol: 'NVDL',
        name: 'GraniteShares 2x Long NVDA Daily ETF',
        assetClass: 'ETF',
        exchange: 'NASDAQ',
        currency: 'USD',
      },
      {
        symbol: 'PTT.BK',
        name: 'PTT Public Company Limited',
        assetClass: 'EQUITY',
        exchange: 'SET',
        currency: 'THB',
      },
      {
        symbol: 'BTC-USD',
        name: 'Bitcoin US Dollar',
        assetClass: 'CRYPTO',
        exchange: 'Coinbase Pro',
        currency: 'USD',
      },
    ]);
  });

  it('getAsset returns the exact canonical match or null', async () => {
    const { p } = provider([
      { body: fixture('symbol_search.json') },
      { body: fixture('symbol_search.json') },
    ]);
    expect((await p.getAsset('PTT.BK'))?.name).toBe('PTT Public Company Limited');
    expect(await p.getAsset('ZZZZ')).toBeNull();
  });
});

describe('RealMarketDataProvider - errors and retries', () => {
  it('does not retry 401 (HTTP status) and normalises it', async () => {
    const { p, urls } = provider([{ status: 401, body: fixture('error_401.json') }]);
    await expect(p.getQuote('NVDA')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      retryable: false,
    });
    expect(urls).toHaveLength(1);
  });

  it('detects errors reported with HTTP 200 in the body', async () => {
    const { p, urls } = provider([{ status: 200, body: fixture('error_401.json') }]);
    await expect(p.getQuote('NVDA')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(urls).toHaveLength(1);
  });

  it('does not retry 403 (plan does not include the endpoint)', async () => {
    const { p, urls } = provider([{ status: 200, body: fixture('error_403.json') }]);
    await expect(p.getHistoricalCandles('NVDA', '1m', 10)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(urls).toHaveLength(1);
  });

  it('maps unknown symbols to UnknownSymbolError without retrying', async () => {
    const { p, urls } = provider([{ status: 400, body: fixture('error_symbol.json') }]);
    const err = await p.getQuote('ZZZZ').catch((e) => e);
    expect(err).toBeInstanceOf(MarketDataError);
    expect(err).toMatchObject({ code: 'INVALID_SYMBOL', symbol: 'ZZZZ', retryable: false });
    expect(urls).toHaveLength(1);
  });

  it('retries 429 and succeeds, honouring Retry-After', async () => {
    const { p, urls, sleeps } = provider([
      { status: 429, body: fixture('error_429.json'), headers: { 'retry-after': '2' } },
      { body: fixture('quote.json') },
    ]);
    expect((await p.getQuote('NVDA')).price).toBe(182.3);
    expect(urls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it.each([500, 502, 503, 504])(
    'retries %i with exponential backoff, bounded by maxRetries',
    async (status) => {
      const { p, urls, sleeps } = provider([
        { status, raw: '<html>bad gateway</html>' },
        { status, body: { status: 'error', code: status, message: 'upstream' } },
        { status },
        { status },
      ]);
      const err = await p.getQuote('NVDA').catch((e) => e);
      expect(err).toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
        retryable: true,
        httpStatus: status,
      });
      expect(urls).toHaveLength(4); // 1 attempt + 3 retries
      expect(sleeps).toEqual([375, 750, 1500]); // equal jitter with random=0.5: 0.75 * 500 * 2^n
    },
  );

  it('caps backoff at maxDelayMs', async () => {
    const replies = Array.from({ length: 8 }, () => ({ status: 503 }));
    const { p, sleeps } = provider(replies, { maxRetries: 7 });
    await expect(p.getQuote('NVDA')).rejects.toBeInstanceOf(MarketDataError);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(10_000);
    expect(sleeps.at(-1)).toBe(10_000);
  });

  it('retries network errors and times out hung requests', async () => {
    const { p, urls } = provider([
      { networkError: 'socket hang up' },
      { hang: true },
      { body: fixture('quote.json') },
    ]);
    expect((await p.getQuote('NVDA')).symbol).toBe('NVDA');
    expect(urls).toHaveLength(3);
  });

  it('reports TIMEOUT after exhausting retries', async () => {
    const { p } = provider([{ hang: true }, { hang: true }], { maxRetries: 1, timeoutMs: 20 });
    await expect(p.getQuote('NVDA')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects malformed responses without retrying', async () => {
    const { p, urls } = provider([{ body: { values: [{ datetime: 'yesterday', open: 'x' }] } }]);
    await expect(p.getHistoricalCandles('NVDA', '5m', 5)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
    expect(urls).toHaveLength(1);
  });

  it('rejects inconsistent OHLC values', async () => {
    const bad = {
      meta: { symbol: 'NVDA', interval: '5min' },
      values: [
        {
          datetime: '2026-09-25 14:30:00',
          open: '10',
          high: '9',
          low: '8',
          close: '9.5',
          volume: '1',
        },
      ],
    };
    const { p } = provider([{ body: bad }]);
    await expect(p.getHistoricalCandles('NVDA', '5m', 1)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });

  it('rejects non-JSON success bodies as BAD_RESPONSE', async () => {
    const { p } = provider([{ status: 200, raw: 'not json' }]);
    await expect(p.getQuote('NVDA')).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
      retryable: false,
    });
  });
});

describe('RealMarketDataProvider - rate limiting', () => {
  it('queues requests beyond the per-minute budget', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new TokenBucketRateLimiter(2, {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire(); // third request in the same minute must wait ~30 s
    expect(waits).toEqual([30_000]);
  });

  it('fails fast with RATE_LIMITED when the wait would exceed the budget', async () => {
    const limiter = new TokenBucketRateLimiter(1, { now: () => 0, sleep: async () => {} });
    await limiter.acquire();
    await expect(limiter.acquire(1_000)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('RealMarketDataProvider - security', () => {
  it('never logs or throws the API key, even when an error message contains the URL', async () => {
    const { p, log, urls } = provider([
      { networkError: `connect ECONNREFUSED https://api.twelvedata.com/quote?apikey=${KEY}` },
      { status: 401, body: fixture('error_401.json') },
    ]);
    const err = await p.getQuote('NVDA').catch((e) => e);
    expect(urls[0]!.searchParams.get('apikey')).toBe(KEY); // sent to the vendor...
    expect(log.text()).not.toContain(KEY); // ...but never logged
    expect(String(err.message)).not.toContain(KEY);
    expect(log.entries.some((e) => JSON.stringify(e).includes('/quote'))).toBe(true);
  });

  it('keeps user-supplied symbols inside query parameters (no path injection)', async () => {
    const { p, urls } = provider([{ body: fixture('quote.json') }]);
    await p.getQuote('../admin?x=1');
    expect(urls[0]!.pathname).toBe('/quote');
    expect(urls[0]!.host).toBe('api.twelvedata.com');
  });

  it('validates MARKET_DATA_BASE_URL against SSRF', () => {
    const d = {
      defaultBaseUrl: 'https://api.twelvedata.com',
      allowedHosts: ['api.twelvedata.com'],
      vendor: 'twelvedata',
    };
    expect(resolveBaseUrl(undefined, d)).toBe('https://api.twelvedata.com');
    expect(() => resolveBaseUrl('http://api.twelvedata.com', d)).toThrow(/https/);
    expect(() => resolveBaseUrl('https://evil.example.com', d)).toThrow(/not an allowed/);
    expect(() => resolveBaseUrl('https://user:pw@api.twelvedata.com', d)).toThrow(/credentials/);
    expect(() =>
      resolveBaseUrl('https://169.254.169.254/latest', d, { allowCustom: true }),
    ).toThrow(/metadata/);
    expect(() => resolveBaseUrl('https://api.twelvedata.com/?apikey=x', d)).toThrow(/query/);
    expect(resolveBaseUrl('https://proxy.internal.example', d, { allowCustom: true })).toBe(
      'https://proxy.internal.example',
    );
    expect(resolveBaseUrl('http://localhost:9000', d, { allowCustom: true })).toBe(
      'http://localhost:9000',
    );
  });

  it('requires a supported vendor and an API key', () => {
    expect(() => new RealMarketDataProvider({ vendor: 'nope', apiKey: KEY })).toThrow(
      ProviderNotConfiguredError,
    );
    expect(() => new RealMarketDataProvider({ vendor: 'twelvedata' })).toThrow(
      /MARKET_DATA_API_KEY/,
    );
  });

  it('UnknownSymbolError is a MarketDataError (single error hierarchy)', () => {
    expect(new UnknownSymbolError('X')).toBeInstanceOf(MarketDataError);
  });
});
