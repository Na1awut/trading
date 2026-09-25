import type { AssetInfo, Candle, Quote, Timeframe } from '@signals/types';
import { TIMEFRAMES } from '@signals/types';
import { MOCK_ASSETS } from './catalog';
import { UnknownSymbolError, type MarketDataProvider } from './provider';

/**
 * In-memory provider whose candles are set explicitly. Used by tests and the
 * vertical-slice demo to reproduce exact scenarios (e.g. "the last completed candle is
 * an EMA 9/21 bullish cross").
 */
export class ScriptedMarketDataProvider implements MarketDataProvider {
  readonly name = 'scripted';
  readonly delayed = false;
  readonly supportedTimeframes = TIMEFRAMES;
  private readonly candles = new Map<string, Candle[]>();
  private readonly assets = new Map<string, AssetInfo>(MOCK_ASSETS.map((a) => [a.symbol, a]));

  constructor(private readonly now: () => number = Date.now) {}

  setCandles(symbol: string, timeframe: Timeframe, candles: Candle[]): this {
    this.candles.set(
      `${symbol.toUpperCase()}:${timeframe}`,
      [...candles].sort((a, b) => a.time - b.time),
    );
    return this;
  }

  addAsset(asset: AssetInfo): this {
    this.assets.set(asset.symbol, asset);
    return this;
  }

  async searchAssets(query: string, limit = 20): Promise<AssetInfo[]> {
    const q = query.toUpperCase();
    return [...this.assets.values()].filter((a) => a.symbol.includes(q)).slice(0, limit);
  }

  async getAsset(symbol: string): Promise<AssetInfo | null> {
    return this.assets.get(symbol.toUpperCase()) ?? null;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const series = this.find(symbol);
    const last = series.at(-1);
    if (!last) throw new UnknownSymbolError(symbol);
    const prev = series.at(-2) ?? last;
    const change = last.close - prev.close;
    return {
      symbol: symbol.toUpperCase(),
      price: last.close,
      previousClose: prev.close,
      change,
      changePercent: prev.close ? (change / prev.close) * 100 : 0,
      volume: last.volume,
      timestamp: new Date(this.now()).toISOString(),
      delayed: false,
      source: this.name,
    };
  }

  async getHistoricalCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<Candle[]> {
    const series = this.candles.get(`${symbol.toUpperCase()}:${timeframe}`);
    if (!series) {
      if (!this.assets.has(symbol.toUpperCase())) throw new UnknownSymbolError(symbol);
      return [];
    }
    return series.slice(-limit);
  }

  private find(symbol: string): Candle[] {
    for (const [key, value] of this.candles) {
      if (key.startsWith(`${symbol.toUpperCase()}:`)) return value;
    }
    throw new UnknownSymbolError(symbol);
  }
}
