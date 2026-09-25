import type { Candle } from '@signals/types';

export const MINUTE = 60_000;

/** Build 1m candles from closes (open = previous close). */
export function candlesFrom(closes: number[], volumes?: number[], start = 0): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    return {
      time: start + i * MINUTE,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: volumes?.[i] ?? 1_000_000,
    };
  });
}

/** Deterministic pseudo-random walk (mulberry32) for property-style tests. */
export function randomWalk(n: number, seed = 42, start = 100): number[] {
  let a = seed;
  const rand = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p = Math.max(1, p * (1 + (rand() - 0.5) * 0.04));
    out.push(Number(p.toFixed(4)));
  }
  return out;
}
