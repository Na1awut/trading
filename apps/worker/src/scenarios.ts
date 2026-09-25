import { ema } from '@signals/signal-engine';
import {
  latestClosedCandleOpenTime,
  timeframeToMs,
  type Candle,
  type Timeframe,
} from '@signals/types';

/**
 * Candles whose LAST COMPLETED candle is an EMA 9/21 bullish crossover, followed by one
 * in-progress candle. Used by the worker tests and the vertical-slice demo.
 */
export function buildEmaBullishCrossScenario(opts: {
  now: number;
  timeframe: Timeframe;
  basePrice?: number;
  volume?: number;
  /** Must match the worker's CANDLE_CLOSE_GRACE_MS so the cross candle counts as closed. */
  graceMs?: number;
}): Candle[] {
  const base = opts.basePrice ?? 180;
  const closes: number[] = [];
  let p = base * 1.08;
  for (let i = 0; i < 60; i++) {
    p -= base * 0.0015;
    closes.push(p);
  }
  for (let guard = 0; guard < 200; guard++) {
    p += base * 0.0035;
    closes.push(p);
    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);
    const n = closes.length - 1;
    if (e9[n - 1]! <= e21[n - 1]! && e9[n]! > e21[n]!) break;
  }

  const tf = timeframeToMs(opts.timeframe);
  const lastCompletedOpen = latestClosedCandleOpenTime(opts.now, opts.timeframe, opts.graceMs ?? 0);
  const candles: Candle[] = closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    return {
      time: lastCompletedOpen - (closes.length - 1 - i) * tf,
      open: round(open),
      high: round(Math.max(open, close) * 1.0005),
      low: round(Math.min(open, close) * 0.9995),
      close: round(close),
      volume: opts.volume ?? 1_000_000,
    };
  });
  const last = candles.at(-1)!;
  // In-progress candle: must be ignored by signal evaluation.
  candles.push({
    ...last,
    time: last.time + tf,
    open: last.close,
    close: round(last.close * 1.002),
    high: round(last.close * 1.003),
  });
  return candles;
}

function round(v: number) {
  return Math.round(v * 100) / 100;
}
