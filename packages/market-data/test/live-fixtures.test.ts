import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Timeframe } from '@signals/types';
import { RealMarketDataProvider } from '../src';
import { fakeFetch } from './helpers';

const DIR = join(__dirname, 'fixtures', 'twelvedata', 'live');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const INTERVAL_TO_TF: Record<string, Timeframe> = {
  '1min': '1m',
  '5min': '5m',
  '15min': '15m',
  '1h': '1h',
  '1day': '1d',
};

const load = (f: string) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as unknown;
const providerFor = (body: unknown) =>
  new RealMarketDataProvider({
    vendor: 'twelvedata',
    apiKey: 'k',
    maxRetries: 0,
    fetch: fakeFetch([{ body }]).fetch,
  });

// Skipped (visibly) until sanitised responses from a live run are committed.
describe.skipIf(files.length === 0)('live Twelve Data fixtures normalise correctly', () => {
  for (const file of files) {
    const [endpoint, symbol, interval] = file.replace(/\.json$/, '').split('__');
    it(file, async () => {
      const body = load(file);
      if (endpoint === 'time_series') {
        const tf = INTERVAL_TO_TF[interval!]!;
        const candles = await providerFor(body).getHistoricalCandles(symbol!, tf, 5000);
        expect(candles.length).toBeGreaterThan(0);
        for (let i = 0; i < candles.length; i++) {
          const c = candles[i]!;
          expect(c.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
          expect(new Date(c.timestamp).getTime()).toBe(c.time);
          expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
          expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
          expect(Number.isFinite(c.volume)).toBe(true);
          if (i > 0) expect(c.time).toBeGreaterThan(candles[i - 1]!.time);
        }
      } else if (endpoint === 'quote') {
        const q = await providerFor(body).getQuote(symbol!);
        expect(q.timestamp).toMatch(/Z$/);
        expect(Number.isFinite(q.price)).toBe(true);
      } else if (endpoint === 'symbol_search') {
        expect(Array.isArray(await providerFor(body).searchSymbols(symbol!))).toBe(true);
      }
    });
  }
});
