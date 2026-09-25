import { assertPeriod } from './moving-averages';

export interface VolumeStats {
  /** Mean volume of the `period` candles BEFORE index i (current candle excluded). */
  average: (number | null)[];
  /** Population standard deviation over the same window. */
  stdDev: (number | null)[];
}

/**
 * Baseline volume statistics. The current candle is deliberately excluded from its own
 * baseline so a spike does not inflate the average it is compared against.
 */
export function volumeStats(volumes: ReadonlyArray<number>, period = 20): VolumeStats {
  assertPeriod(period);
  const average: (number | null)[] = new Array(volumes.length).fill(null);
  const stdDev: (number | null)[] = new Array(volumes.length).fill(null);
  for (let i = period; i < volumes.length; i++) {
    let sum = 0;
    for (let j = i - period; j < i; j++) sum += volumes[j]!;
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period; j < i; j++) sq += (volumes[j]! - mean) ** 2;
    average[i] = mean;
    stdDev[i] = Math.sqrt(sq / period);
  }
  return { average, stdDev };
}
