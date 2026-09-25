import type { Candle } from '@signals/types';
import { ema, sma } from './moving-averages';
import { rsi } from './rsi';
import { macd, type MacdSeries } from './macd';
import { volumeStats, type VolumeStats } from './volume';

/**
 * Memoised indicator series for one candle array. The worker evaluates many signal
 * definitions against the same (symbol, timeframe) candles, so each series is only
 * computed once per evaluation cycle.
 */
export class IndicatorContext {
  readonly closes: number[];
  readonly volumes: number[];
  private readonly cache = new Map<string, unknown>();

  constructor(readonly candles: ReadonlyArray<Candle>) {
    this.closes = candles.map((c) => c.close);
    this.volumes = candles.map((c) => c.volume);
  }

  get length(): number {
    return this.candles.length;
  }

  ema(period: number): (number | null)[] {
    return this.memo(`ema:${period}`, () => ema(this.closes, period));
  }

  sma(period: number): (number | null)[] {
    return this.memo(`sma:${period}`, () => sma(this.closes, period));
  }

  rsi(period: number): (number | null)[] {
    return this.memo(`rsi:${period}`, () => rsi(this.closes, period));
  }

  macd(fast: number, slow: number, signal: number): MacdSeries {
    return this.memo(`macd:${fast}:${slow}:${signal}`, () => macd(this.closes, fast, slow, signal));
  }

  volume(period: number): VolumeStats {
    return this.memo(`vol:${period}`, () => volumeStats(this.volumes, period));
  }

  /** Distinct indicator series computed so far (each is computed at most once). */
  get computedSeries(): string[] {
    return [...this.cache.keys()];
  }

  private memo<T>(key: string, compute: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, compute());
    return this.cache.get(key) as T;
  }
}
