import type { AssetInfo, Candle, NormalizedCandle, Quote, Timeframe } from '@signals/types';
import { TIMEFRAMES } from '@signals/types';
import { MOCK_ASSETS } from './catalog';
import { UnknownSymbolError } from './errors';
import type { MarketDataProvider } from './provider';

export interface ProviderCall {
  method: 'getQuote' | 'getHistoricalCandles' | 'searchSymbols' | 'getAsset';
  symbol?: string;
  timeframe?: Timeframe;
  limit?: number;
}

/**
 * In-memory provider whose data is set explicitly. Used by tests and the vertical-slice
 * demo to reproduce exact scenarios; records every call so tests can assert fetch counts.
 */
export class ScriptedMarketDataProvider implements MarketDataProvider {
  readonly name: string;
  readonly delayed = false;
  readonly supportedTimeframes = TIMEFRAMES;
  readonly calls: ProviderCall[] = [];
  private readonly candles = new Map<string, NormalizedCandle[]>();
  private readonly quotes = new Map<string, Partial<Quote>>();
  private readonly assets = new Map<string, AssetInfo>(MOCK_ASSETS.map((a) => [a.symbol, a]));

  constructor(
    private readonly now: () => number = Date.now,
    name = 'scripted',
  ) {
    this.name = name;
  }

  setCandles(symbol: string, timeframe: Timeframe, candles: Candle[]): this {
    const s = symbol.toUpperCase();
    this.candles.set(
      `${s}:${timeframe}`,
      [...candles]
        .sort((a, b) => a.time - b.time)
        .map((c) => ({ ...c, symbol: s, timeframe, timestamp: new Date(c.time).toISOString() })),
    );
    return this;
  }

  /** Override quote fields (e.g. an old timestamp to simulate stale data). */
  setQuote(symbol: string, quote: Partial<Quote>): this {
    this.quotes.set(symbol.toUpperCase(), quote);
    return this;
  }

  addAsset(asset: AssetInfo): this {
    this.assets.set(asset.symbol, asset);
    return this;
  }

  callsFor(method: ProviderCall['method'], symbol?: string): ProviderCall[] {
    return this.calls.filter((c) => c.method === method && (!symbol || c.symbol === symbol));
  }

  async searchSymbols(query: string, limit = 20): Promise<AssetInfo[]> {
    this.calls.push({ method: 'searchSymbols' });
    const q = query.toUpperCase();
    return [...this.assets.values()].filter((a) => a.symbol.includes(q)).slice(0, limit);
  }

  async getAsset(symbol: string): Promise<AssetInfo | null> {
    this.calls.push({ method: 'getAsset', symbol });
    return this.assets.get(symbol.toUpperCase()) ?? null;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const s = symbol.toUpperCase();
    this.calls.push({ method: 'getQuote', symbol: s });
    const asset = this.assets.get(s);
    const override = this.quotes.get(s);
    const series = this.findSeries(s);
    const last = series?.at(-1);
    if (!asset || (!last && !override)) throw new UnknownSymbolError(symbol);
    const prev = series?.at(-2) ?? last;
    const price = override?.price ?? last!.close;
    const previousClose = override?.previousClose ?? prev!.close;
    const change = price - previousClose;
    return {
      symbol: s,
      price,
      previousClose,
      change,
      changePercent: previousClose ? (change / previousClose) * 100 : 0,
      volume: last?.volume ?? 0,
      timestamp: new Date(this.now()).toISOString(),
      currency: asset.currency,
      exchange: asset.exchange,
      marketOpen: true,
      delayed: false,
      source: this.name,
      ...override,
    };
  }

  async getHistoricalCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<NormalizedCandle[]> {
    const s = symbol.toUpperCase();
    this.calls.push({ method: 'getHistoricalCandles', symbol: s, timeframe, limit });
    const series = this.candles.get(`${s}:${timeframe}`);
    if (!series) {
      if (!this.assets.has(s)) throw new UnknownSymbolError(symbol);
      return [];
    }
    // Like a real vendor: nothing that has not started yet.
    const now = this.now();
    return series.filter((c) => c.time <= now).slice(-limit);
  }

  private findSeries(symbol: string): NormalizedCandle[] | undefined {
    for (const [key, value] of this.candles) {
      if (key.startsWith(`${symbol}:`)) return value;
    }
    return undefined;
  }
}
