import { z } from 'zod';
import type { AssetClass, AssetInfo, NormalizedCandle, Quote, Timeframe } from '@signals/types';
import { MarketDataError } from '../errors';
import { statusToError, type RequestMeta } from '../http/vendor-http-client';
import type { ParseContext, VendorAdapter } from './types';

/**
 * Twelve Data (https://twelvedata.com/docs) adapter.
 *
 * Endpoints used: /quote, /time_series, /symbol_search. Notable vendor behaviour handled here:
 * - errors can arrive with HTTP 200 and a body of {status: "error", code, message};
 * - numeric fields are strings;
 * - intraday datetimes honour `timezone=UTC`; daily bars are exchange-local DATES
 *   ("2026-01-12"), which we store as that date at 00:00 UTC;
 * - newest-first ordering by default - we request ascending and sort defensively.
 *
 * Nothing in this file is exported from the package index: vendor shapes stay private.
 */

const INTERVALS: Record<Timeframe, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '1h': '1h',
  '1d': '1day',
};

const EXTENDED_INTERVALS = new Set<Timeframe>(['1m', '5m', '15m']);

/** Exchanges we list, keyed by Twelve Data exchange name -> canonical suffix. */
const US_EXCHANGES = new Set([
  'NASDAQ',
  'NYSE',
  'NYSE ARCA',
  'NYSE AMERICAN',
  'AMEX',
  'CBOE',
  'BATS',
]);
const CRYPTO_QUOTES = new Set(['USD', 'USDT', 'USDC', 'EUR', 'BTC', 'ETH', 'THB']);

const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v : Number(v)))
  .refine((n) => Number.isFinite(n), 'expected a finite number');

const ErrorBody = z.object({
  status: z.literal('error'),
  code: z.coerce.number(),
  message: z.string().default(''),
});

const QuoteBody = z.object({
  symbol: z.string(),
  exchange: z.string().optional(),
  currency: z.string().optional(),
  timestamp: z.coerce.number().int().positive(),
  close: numeric,
  previous_close: numeric,
  change: numeric.optional(),
  percent_change: numeric.optional(),
  volume: numeric.optional(),
  is_market_open: z.boolean().optional(),
});

const TimeSeriesBody = z.object({
  meta: z.object({ symbol: z.string(), interval: z.string() }).passthrough(),
  values: z
    .array(
      z.object({
        datetime: z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/),
        open: numeric,
        high: numeric,
        low: numeric,
        close: numeric,
        volume: numeric.optional(),
      }),
    )
    .default([]),
});

const SearchBody = z.object({
  data: z
    .array(
      z.object({
        symbol: z.string(),
        instrument_name: z.string().default(''),
        exchange: z.string().default(''),
        currency: z.string().default(''),
        instrument_type: z.string().default(''),
      }),
    )
    .default([]),
});

/** Canonical symbol -> Twelve Data query params. */
export function toVendorSymbol(symbol: string): Record<string, string> {
  const s = symbol.toUpperCase();
  const set = /^([A-Z0-9]+)\.BK$/.exec(s);
  if (set) return { symbol: set[1]!, exchange: 'SET' };
  const pair = /^([A-Z0-9]{2,10})-([A-Z]{3,4})$/.exec(s);
  if (pair && CRYPTO_QUOTES.has(pair[2]!)) return { symbol: `${pair[1]}/${pair[2]}` };
  return { symbol: s };
}

/** Twelve Data search row -> canonical asset, or null if we don't support the listing. */
function fromVendorListing(row: z.infer<typeof SearchBody>['data'][number]): AssetInfo | null {
  const type = row.instrument_type.toLowerCase();
  let assetClass: AssetClass | null = null;
  if (type === 'etf') assetClass = 'ETF';
  else if (type === 'index') assetClass = 'INDEX';
  else if (type === 'digital currency') assetClass = 'CRYPTO';
  else if (type === 'physical currency') assetClass = 'FOREX';
  else if (/(common stock|preferred stock|depositary receipt|reit)/.test(type))
    assetClass = 'EQUITY';
  if (!assetClass) return null;

  const exchange = row.exchange.toUpperCase();
  let symbol: string;
  if (assetClass === 'CRYPTO' || assetClass === 'FOREX') {
    symbol = row.symbol.replace('/', '-');
  } else if (exchange === 'SET') {
    symbol = `${row.symbol}.BK`;
  } else if (US_EXCHANGES.has(exchange)) {
    symbol = row.symbol;
  } else {
    return null; // other venues would collide with US tickers; add explicit mapping first
  }
  return {
    symbol: symbol.toUpperCase(),
    name: row.instrument_name || symbol,
    assetClass,
    exchange: row.exchange || 'UNKNOWN',
    currency: row.currency || 'USD',
  };
}

/** "2026-01-12 14:30:00" (UTC, as requested) or "2026-01-12" (daily) -> epoch ms. */
export function parseVendorDatetime(value: string): number {
  const [date, time = '00:00:00'] = value.split(' ');
  const [y, m, d] = date!.split('-').map(Number);
  const [hh, mm, ss = 0] = time.split(':').map(Number);
  return Date.UTC(y!, m! - 1, d!, hh!, mm!, ss);
}

function badResponse(what: string, error: z.ZodError, symbol?: string): MarketDataError {
  const detail = error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
    .join('; ');
  return new MarketDataError('BAD_RESPONSE', `Malformed ${what} response: ${detail}`, {
    vendor: 'twelvedata',
    symbol,
  });
}

export const twelveDataAdapter: VendorAdapter = {
  vendor: 'twelvedata',
  defaultBaseUrl: 'https://api.twelvedata.com',
  allowedHosts: ['api.twelvedata.com'],
  supportedTimeframes: ['1m', '5m', '15m', '1h', '1d'],
  maxCandlesPerRequest: 5000,

  authQuery: (apiKey) => ({ apikey: apiKey }),

  classifyError(status: number, body: unknown, meta: RequestMeta) {
    const err = ErrorBody.safeParse(body);
    const code = err.success ? err.data.code : status;
    if (!err.success && status >= 200 && status < 300) return null;
    const message = err.success ? err.data.message : `HTTP ${status}`;
    // Twelve Data reports unknown symbols as 400/404 with a message mentioning the symbol.
    if (
      (code === 400 || code === 404) &&
      /symbol|not found|invalid/i.test(message) &&
      meta.symbol
    ) {
      return new MarketDataError('INVALID_SYMBOL', `Unknown symbol: ${meta.symbol}`, {
        vendor: 'twelvedata',
        httpStatus: code,
        symbol: meta.symbol,
      });
    }
    return statusToError(code, message, 'twelvedata', meta.symbol);
  },

  quoteRequest: (symbol) => ({ path: '/quote', query: toVendorSymbol(symbol) }),

  parseQuote(body: unknown, symbol: string, ctx: ParseContext): Quote {
    const parsed = QuoteBody.safeParse(body);
    if (!parsed.success) throw badResponse('quote', parsed.error, symbol);
    const q = parsed.data;
    const change = q.change ?? q.close - q.previous_close;
    return {
      symbol,
      price: q.close,
      previousClose: q.previous_close,
      change,
      changePercent: q.percent_change ?? (q.previous_close ? (change / q.previous_close) * 100 : 0),
      volume: q.volume ?? 0,
      timestamp: new Date(q.timestamp * 1000).toISOString(),
      currency: q.currency ?? 'USD',
      exchange: q.exchange ?? 'UNKNOWN',
      marketOpen: q.is_market_open ?? null,
      delayed: ctx.delayed,
      source: ctx.source,
    };
  },

  candlesRequest: (symbol, timeframe, limit, options) => {
    const vendorSymbol = toVendorSymbol(symbol);
    // Twelve Data documents pre/post-market data ("prepost") for US equities at intraday
    // intervals up to 30min on Pro+ plans. Crypto/forex pairs trade 24/7: never session-filtered.
    const isPair = vendorSymbol.symbol!.includes('/');
    const extended =
      options?.sessionMode === 'extended' && !isPair && EXTENDED_INTERVALS.has(timeframe);
    return {
      path: '/time_series',
      query: {
        ...vendorSymbol,
        interval: INTERVALS[timeframe],
        outputsize: String(Math.min(Math.max(limit, 1), 5000)),
        timezone: 'UTC',
        order: 'asc',
        ...(extended ? { prepost: 'true' } : {}),
      },
    };
  },

  parseCandles(body: unknown, symbol: string, timeframe: Timeframe): NormalizedCandle[] {
    const parsed = TimeSeriesBody.safeParse(body);
    if (!parsed.success) throw badResponse('time_series', parsed.error, symbol);
    const candles = parsed.data.values.map((v): NormalizedCandle => {
      const time = parseVendorDatetime(v.datetime);
      return {
        symbol,
        timeframe,
        time,
        timestamp: new Date(time).toISOString(),
        open: v.open,
        high: v.high,
        low: v.low,
        close: v.close,
        volume: v.volume ?? 0,
      };
    });
    for (const c of candles) {
      if (c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.low < 0) {
        throw new MarketDataError('BAD_RESPONSE', `Inconsistent OHLC values at ${c.timestamp}`, {
          vendor: 'twelvedata',
          symbol,
        });
      }
    }
    // Ascending, de-duplicated by open time.
    const byTime = new Map(candles.map((c) => [c.time, c]));
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  },

  searchRequest: (query, limit) => ({
    path: '/symbol_search',
    query: { symbol: query, outputsize: String(Math.min(Math.max(limit * 3, 10), 120)) },
  }),

  parseSearch(body: unknown): AssetInfo[] {
    const parsed = SearchBody.safeParse(body);
    if (!parsed.success) throw badResponse('symbol_search', parsed.error);
    const out = new Map<string, AssetInfo>();
    for (const row of parsed.data.data) {
      const asset = fromVendorListing(row);
      if (asset && !out.has(asset.symbol)) out.set(asset.symbol, asset);
    }
    return [...out.values()];
  },
};
