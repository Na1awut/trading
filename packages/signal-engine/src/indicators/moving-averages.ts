/**
 * Indicator functions return arrays aligned 1:1 with the input series.
 * Positions without enough history are `null` (never NaN / 0), so callers can
 * distinguish "not enough data" from a real value.
 */
export type Series = ReadonlyArray<number | null>;

/** Simple moving average over the last `period` values (inclusive of the current one). */
export function sma(values: ReadonlyArray<number>, period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, k = 2 / (period + 1), seeded with the SMA of the first
 * `period` values (the convention used by most charting platforms and TA-Lib).
 *
 * Leading `null`s in the input are skipped, which lets us take the EMA of another
 * indicator (e.g. the MACD signal line is the EMA of the MACD line).
 */
export function ema(values: Series, period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  const start = values.findIndex((v) => v !== null);
  if (start === -1) return out;

  let prev: number | null = null;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = start; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) {
      throw new Error(`ema(): unexpected null at index ${i} after series start`);
    }
    if (prev === null) {
      seedSum += v;
      seedCount++;
      if (seedCount === period) {
        prev = seedSum / period;
        out[i] = prev;
      }
    } else {
      prev = (v - prev) * k + prev;
      out[i] = prev;
    }
  }
  return out;
}

export function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`period must be a positive integer, got ${period}`);
  }
}
