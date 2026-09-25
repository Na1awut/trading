import type { Candle, Timeframe } from '@signals/types';
import { IndicatorContext } from './indicators/context';

/**
 * Everything a signal needs for one (symbol, timeframe) evaluation: the completed candle
 * series and a memoised indicator cache. Built once per pair per evaluation cycle and shared
 * by every signal definition, so EMA/RSI/MACD are never recomputed per signal or per user.
 */
export interface SignalContext {
  symbol: string;
  timeframe: Timeframe;
  /** COMPLETED candles only, ascending. */
  candles: ReadonlyArray<Candle>;
  /** Latest completed candle (evaluation target unless an index is given). */
  currentCandle: Candle | null;
  previousCandle: Candle | null;
  indicators: IndicatorContext;
}

export function createSignalContext(
  symbol: string,
  timeframe: Timeframe,
  candles: ReadonlyArray<Candle>,
): SignalContext {
  return {
    symbol,
    timeframe,
    candles,
    currentCandle: candles.at(-1) ?? null,
    previousCandle: candles.at(-2) ?? null,
    indicators: new IndicatorContext(candles),
  };
}

export function isSignalContext(v: unknown): v is SignalContext {
  return typeof v === 'object' && v !== null && 'indicators' in v && 'symbol' in v;
}
