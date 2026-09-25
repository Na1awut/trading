import { z } from 'zod';

/**
 * Asset classes. Only EQUITY/ETF are exercised by the MVP mock data, but every layer
 * (provider, DB, API, UI) carries the class so crypto, indices, forex, commodities and
 * non-US listings (e.g. Thai equities on the SET, suffix `.BK`) can be added later.
 */
export const ASSET_CLASSES = ['EQUITY', 'ETF', 'INDEX', 'CRYPTO', 'FOREX', 'COMMODITY'] as const;
export const AssetClassSchema = z.enum(ASSET_CLASSES);
export type AssetClass = z.infer<typeof AssetClassSchema>;

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '1d'] as const;
export const TimeframeSchema = z.enum(TIMEFRAMES);
export type Timeframe = z.infer<typeof TimeframeSchema>;

const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

export function timeframeToMs(timeframe: Timeframe): number {
  return TIMEFRAME_MS[timeframe];
}

/** Start (open time) of the candle bucket that contains `timestampMs`. UTC-aligned. */
export function candleOpenTime(timestampMs: number, timeframe: Timeframe): number {
  const ms = timeframeToMs(timeframe);
  return Math.floor(timestampMs / ms) * ms;
}

/**
 * A candle is complete once its full interval has elapsed, plus an optional grace period
 * that gives the vendor time to publish the final bar (late trades, aggregation lag).
 */
export function isCandleComplete(
  candle: Pick<Candle, 'time'>,
  timeframe: Timeframe,
  nowMs: number,
  graceMs = 0,
): boolean {
  return candle.time + timeframeToMs(timeframe) + graceMs <= nowMs;
}

/**
 * Open time (epoch ms, UTC) of the most recent candle that is fully closed at `nowMs`.
 * e.g. 5m at 14:37:30 -> 14:30 (the 14:30-14:35 bar); at 14:35:00 exactly -> 14:30.
 */
export function latestClosedCandleOpenTime(
  nowMs: number,
  timeframe: Timeframe,
  graceMs = 0,
): number {
  return candleOpenTime(nowMs - graceMs, timeframe) - timeframeToMs(timeframe);
}

export const SymbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9.^=\-/]+$/, 'Invalid symbol')
  .transform((s) => s.toUpperCase());

export interface AssetInfo {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  exchange: string;
  currency: string;
}

export const AssetInfoSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  assetClass: AssetClassSchema,
  exchange: z.string(),
  currency: z.string(),
});

/** OHLCV candle. `time` is the candle OPEN time in epoch milliseconds (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Normalised candle returned by every MarketDataProvider. Vendor formats never leave
 * packages/market-data. `time` (epoch ms) and `timestamp` (ISO 8601) are the same instant:
 * the candle OPEN time in UTC. The signal engine only needs the `Candle` subset.
 */
export interface NormalizedCandle extends Candle {
  symbol: string;
  timeframe: Timeframe;
  timestamp: string;
}

/** Normalised quote. All timestamps are UTC (ISO 8601); clients convert for display. */
export interface Quote {
  symbol: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  volume: number;
  /** When the vendor last updated this price (ISO 8601, UTC). */
  timestamp: string;
  currency: string;
  exchange: string;
  /** Vendor-reported session state; null when the vendor does not say. */
  marketOpen: boolean | null;
  /** True when the provider's data is delayed (most free/cheap tiers are). */
  delayed: boolean;
  source: string;
}

export const QuoteSchema = z.object({
  symbol: z.string(),
  price: z.number(),
  previousClose: z.number(),
  change: z.number(),
  changePercent: z.number(),
  volume: z.number(),
  timestamp: z.string(),
  currency: z.string(),
  exchange: z.string(),
  marketOpen: z.boolean().nullable(),
  delayed: z.boolean(),
  source: z.string(),
});

/** Freshness assessment returned alongside prices so the UI can flag stale data. */
export const DataFreshnessSchema = z.object({
  /** True when data is older than expected while the market is (or may be) open. */
  stale: z.boolean(),
  ageSeconds: z.number().nullable(),
  marketOpen: z.boolean().nullable(),
  reason: z.string().nullable(),
});
export type DataFreshness = z.infer<typeof DataFreshnessSchema>;
