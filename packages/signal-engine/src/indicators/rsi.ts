import { assertPeriod } from './moving-averages';

/**
 * Relative Strength Index using Wilder's smoothing (the original definition, and what
 * TradingView / StockCharts display).
 *
 * - First average gain/loss = simple mean of the first `period` changes.
 * - Afterwards: avg = (prevAvg * (period - 1) + current) / period.
 * - The first RSI value is at index `period` (it needs `period` price changes).
 */
export function rsi(closes: ReadonlyArray<number>, period = 14): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
