import type { AssetInfo, NormalizedCandle, Quote, Timeframe } from '@signals/types';
import { TIMEFRAMES, candleOpenTime, timeframeToMs } from '@signals/types';
import { MOCK_ASSETS, type MockAsset } from './catalog';
import { UnknownSymbolError, type MarketDataProvider } from './provider';

const MINUTE = 60_000;

export interface MockProviderOptions {
  /** Injectable clock for tests. */
  now?: () => number;
  assets?: MockAsset[];
}

/**
 * Deterministic synthetic market data.
 *
 * Price is a PURE FUNCTION of (symbol, time): a sum of sine waves at intraday,
 * multi-hour and multi-week periods plus smooth hash-based noise. Consequences:
 *  - the API process and the worker process see identical candles with no shared state;
 *  - every timeframe is consistent (a 1h close equals the last 1m close in that hour);
 *  - EMA/RSI/MACD crossovers occur regularly, so alerts can be observed during development
 *    (on 1m candles an EMA 9/21 cross happens roughly every 20-40 minutes per symbol).
 * Volume includes occasional deterministic spikes to exercise volume signals.
 */
export class MockMarketDataProvider implements MarketDataProvider {
  readonly name = 'mock';
  readonly delayed = false;
  readonly supportedTimeframes = TIMEFRAMES;
  private readonly now: () => number;
  private readonly assets: Map<string, MockAsset>;

  constructor(options: MockProviderOptions = {}) {
    this.now = options.now ?? Date.now;
    this.assets = new Map((options.assets ?? MOCK_ASSETS).map((a) => [a.symbol, a]));
  }

  async searchSymbols(query: string, limit = 20): Promise<AssetInfo[]> {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    const matches = [...this.assets.values()].filter(
      (a) => a.symbol.includes(q) || a.name.toUpperCase().includes(q),
    );
    // exact / prefix symbol matches first
    matches.sort((a, b) => rank(a, q) - rank(b, q) || a.symbol.localeCompare(b.symbol));
    return matches.slice(0, limit).map(toInfo);
  }

  async getAsset(symbol: string): Promise<AssetInfo | null> {
    const a = this.assets.get(symbol.toUpperCase());
    return a ? toInfo(a) : null;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const asset = this.require(symbol);
    const now = this.now();
    const price = round(this.priceAt(asset, now));
    const previousClose = round(this.priceAt(asset, candleOpenTime(now, '1d')));
    const change = price - previousClose;
    const minutesToday = Math.max(1, (now - candleOpenTime(now, '1d')) / MINUTE);
    return {
      symbol: asset.symbol,
      price,
      previousClose,
      change: round(change),
      changePercent: round((change / previousClose) * 100, 4),
      volume: Math.round(asset.baseVolumePerMinute * minutesToday),
      timestamp: new Date(now).toISOString(),
      currency: asset.currency,
      exchange: asset.exchange,
      marketOpen: true, // synthetic 24/7 market
      delayed: this.delayed,
      source: this.name,
    };
  }

  async getHistoricalCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<NormalizedCandle[]> {
    const asset = this.require(symbol);
    const tf = timeframeToMs(timeframe);
    const now = this.now();
    const currentOpen = candleOpenTime(now, timeframe);
    const candles: NormalizedCandle[] = [];
    for (let k = limit - 1; k >= 0; k--) {
      const open = currentOpen - k * tf;
      // The current candle is in progress: its "close" is the latest price.
      const end = Math.min(open + tf, now);
      candles.push(this.buildCandle(asset, open, end, timeframe));
    }
    return candles;
  }

  /** Exposed for tests/demo tooling. */
  priceAt(asset: MockAsset, t: number): number {
    const seed = hash(asset.symbol);
    const phase = (n: number) => (((seed >>> n) % 1000) / 1000) * 2 * Math.PI;
    const minutes = t / MINUTE;
    const wave =
      0.006 * Math.sin((2 * Math.PI * minutes) / 47 + phase(1)) +
      0.004 * Math.sin((2 * Math.PI * minutes) / 13 + phase(5)) +
      0.018 * Math.sin((2 * Math.PI * minutes) / 390 + phase(9)) +
      0.06 * Math.sin((2 * Math.PI * minutes) / (60 * 24 * 23) + phase(13));
    return asset.basePrice * Math.exp(wave + 0.0015 * smoothNoise(seed, minutes));
  }

  private buildCandle(
    asset: MockAsset,
    open: number,
    end: number,
    timeframe: Timeframe,
  ): NormalizedCandle {
    const o = this.priceAt(asset, open);
    const c = this.priceAt(asset, end);
    let high = Math.max(o, c);
    let low = Math.min(o, c);
    const samples = 6;
    for (let s = 1; s < samples; s++) {
      const p = this.priceAt(asset, open + ((end - open) * s) / samples);
      high = Math.max(high, p);
      low = Math.min(low, p);
    }
    const minutes = Math.max(1, (end - open) / MINUTE);
    const seed = hash(`${asset.symbol}:${timeframe}:${open}`);
    const r = (seed % 10_000) / 10_000;
    let volume = asset.baseVolumePerMinute * minutes * (0.75 + 0.5 * r);
    // ~5% of candles are volume spikes (1.8x - 3.3x)
    if ((seed >>> 16) % 100 < 5) volume *= 1.8 + ((seed >>> 8) % 150) / 100;
    return {
      symbol: asset.symbol,
      timeframe,
      time: open,
      timestamp: new Date(open).toISOString(),
      open: round(o),
      high: round(high),
      low: round(low),
      close: round(c),
      volume: Math.round(volume),
    };
  }

  private require(symbol: string): MockAsset {
    const a = this.assets.get(symbol.toUpperCase());
    if (!a) throw new UnknownSymbolError(symbol);
    return a;
  }
}

function toInfo(a: MockAsset): AssetInfo {
  return {
    symbol: a.symbol,
    name: a.name,
    assetClass: a.assetClass,
    exchange: a.exchange,
    currency: a.currency,
  };
}

function rank(a: AssetInfo, q: string): number {
  if (a.symbol === q) return 0;
  if (a.symbol.startsWith(q)) return 1;
  return 2;
}

function round(v: number, decimals?: number): number {
  const d = decimals ?? (Math.abs(v) < 1 ? 6 : 4);
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/** FNV-1a 32-bit. */
export function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Value noise in [-1, 1], cosine-interpolated between integer minutes. */
function smoothNoise(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = lattice(seed, i);
  const b = lattice(seed, i + 1);
  const t = (1 - Math.cos(f * Math.PI)) / 2;
  return a * (1 - t) + b * t;
}

function lattice(seed: number, i: number): number {
  return (hash(`${seed}:${i}`) / 0xffffffff) * 2 - 1;
}
