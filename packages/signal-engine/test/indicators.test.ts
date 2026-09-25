import { describe, expect, it } from 'vitest';
import { EMA, MACD, RSI, SMA } from 'technicalindicators';
import { ema, macd, rsi, sma, volumeStats } from '../src';
import { randomWalk } from './helpers';

const defined = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);

describe('sma', () => {
  it('computes a rolling mean and leaves warm-up positions null', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('rejects invalid periods', () => {
    expect(() => sma([1, 2], 0)).toThrow(RangeError);
  });
});

describe('ema', () => {
  it('seeds with the SMA and applies k = 2/(n+1)', () => {
    // seed = mean(1,2,3) = 2; k = 0.5 -> 3, 4, 5 ... (EMA of a line lags by one step)
    expect(ema([1, 2, 3, 4, 5, 6], 3)).toEqual([null, null, 2, 3, 4, 5]);
  });

  it('matches the StockCharts EMA(10) reference table', () => {
    // https://school.stockcharts.com/doku.php?id=technical_indicators:moving_averages
    const closes = [
      22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29, 22.15, 22.39, 22.38,
      22.61, 23.36, 24.05, 23.75, 23.83, 23.95, 23.63, 23.82, 23.87, 23.65, 23.19, 23.1, 23.33,
      22.68, 23.1, 22.4, 22.17,
    ];
    const expected = [
      22.22, 22.21, 22.24, 22.27, 22.33, 22.52, 22.8, 22.97, 23.13, 23.28, 23.34, 23.43, 23.51,
      23.54, 23.47, 23.4, 23.39, 23.26, 23.23, 23.08, 22.92,
    ];
    const out = defined(ema(closes, 10));
    expect(out).toHaveLength(expected.length);
    // StockCharts' spreadsheet rounds each intermediate EMA to 2 dp, so allow ~1 cent drift.
    out.forEach((v, i) => expect(Math.abs(v - expected[i]!)).toBeLessThan(0.011));
  });

  it('skips leading nulls (EMA of another indicator)', () => {
    expect(ema([null, null, 1, 2, 3, 4], 2)).toEqual([null, null, null, 1.5, 2.5, 3.5]);
  });

  it('agrees with the technicalindicators library on a long random walk', () => {
    const closes = randomWalk(300, 7);
    for (const period of [9, 20, 21, 50]) {
      const ours = defined(ema(closes, period));
      const ref = EMA.calculate({ period, values: closes });
      expect(ours).toHaveLength(ref.length);
      ours.forEach((v, i) => expect(v).toBeCloseTo(ref[i]!, 6));
      const oursSma = defined(sma(closes, period));
      SMA.calculate({ period, values: closes }).forEach((v, i) =>
        expect(oursSma[i]).toBeCloseTo(v, 6),
      );
    }
  });
});

describe('rsi (Wilder, 14)', () => {
  // Classic Wilder/StockCharts worked example.
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
    46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
  ];

  it('is null until 14 price changes are available', () => {
    const out = rsi(closes, 14);
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(out[14]).not.toBeNull();
  });

  it('matches the exact hand calculation for the first value', () => {
    // gains = 3.34/14, losses = 1.40/14 -> RS = 2.385714 -> RSI = 100 - 100/3.385714
    expect(rsi(closes, 14)[14]).toBeCloseTo(70.4641, 4);
  });

  it('tracks the published StockCharts table (which rounds intermediates)', () => {
    const published = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97];
    const out = defined(rsi(closes, 14));
    published.forEach((v, i) => expect(Math.abs(out[i]! - v)).toBeLessThan(0.15));
  });

  it('agrees with the technicalindicators library on a long random walk', () => {
    const series = randomWalk(400, 11);
    const ours = defined(rsi(series, 14));
    const ref = RSI.calculate({ period: 14, values: series });
    expect(ours).toHaveLength(ref.length);
    // the library rounds RSI to 2 decimals
    ours.forEach((v, i) => expect(Math.abs(v - ref[i]!)).toBeLessThan(0.006));
  });

  it('handles flat and one-directional series', () => {
    expect(rsi(new Array(20).fill(10), 14)[19]).toBe(50);
    expect(
      rsi(
        Array.from({ length: 20 }, (_, i) => i + 1),
        14,
      )[19],
    ).toBe(100);
    expect(
      rsi(
        Array.from({ length: 20 }, (_, i) => 100 - i),
        14,
      )[19],
    ).toBe(0);
  });

  it('stays within [0, 100]', () => {
    for (const v of defined(rsi(randomWalk(500, 3), 14))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe('macd (12, 26, 9)', () => {
  const closes = randomWalk(300, 21);

  it('defines MACD from index 25 and the signal line from index 33', () => {
    const out = macd(closes);
    expect(out.macd[24]).toBeNull();
    expect(out.macd[25]).not.toBeNull();
    expect(out.signal[32]).toBeNull();
    expect(out.signal[33]).not.toBeNull();
  });

  it('macd = ema12 - ema26 and histogram = macd - signal', () => {
    const out = macd(closes);
    const e12 = ema(closes, 12);
    const e26 = ema(closes, 26);
    for (let i = 40; i < closes.length; i += 17) {
      expect(out.macd[i]).toBeCloseTo(e12[i]! - e26[i]!, 10);
      expect(out.histogram[i]).toBeCloseTo(out.macd[i]! - out.signal[i]!, 10);
    }
  });

  it('agrees with the technicalindicators library (EMA oscillator + EMA signal)', () => {
    const ours = macd(closes);
    const ref = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    const offset = closes.length - ref.length;
    ref.forEach((r, j) => {
      const i = j + offset;
      expect(ours.macd[i]).toBeCloseTo(r.MACD!, 6);
      if (r.signal !== undefined) expect(ours.signal[i]).toBeCloseTo(r.signal, 6);
      if (r.histogram !== undefined) expect(ours.histogram[i]).toBeCloseTo(r.histogram, 6);
    });
  });

  it('rejects fast >= slow', () => {
    expect(() => macd(closes, 26, 12)).toThrow(RangeError);
  });
});

describe('volumeStats', () => {
  it('averages the previous N volumes, excluding the current candle', () => {
    const vols = [10, 20, 30, 40, 1000];
    const { average, stdDev } = volumeStats(vols, 4);
    expect(average.slice(0, 4)).toEqual([null, null, null, null]);
    expect(average[4]).toBe(25);
    expect(stdDev[4]).toBeCloseTo(Math.sqrt(125), 10);
  });
});
