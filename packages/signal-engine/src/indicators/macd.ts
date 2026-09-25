import { ema } from './moving-averages';

export interface MacdSeries {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

/**
 * MACD line = EMA(fast) - EMA(slow); signal = EMA(signalPeriod) of the MACD line;
 * histogram = MACD - signal. Defaults 12 / 26 / 9.
 */
export function macd(
  closes: ReadonlyArray<number>,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdSeries {
  if (fastPeriod >= slowPeriod) {
    throw new RangeError('MACD fast period must be shorter than slow period');
  }
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const macdLine = closes.map((_, i) => {
    const f = fast[i];
    const s = slow[i];
    return f == null || s == null ? null : f - s;
  });
  const signal = ema(macdLine, signalPeriod);
  const histogram = macdLine.map((m, i) => {
    const s = signal[i];
    return m == null || s == null ? null : m - s;
  });
  return { macd: macdLine, signal, histogram };
}
