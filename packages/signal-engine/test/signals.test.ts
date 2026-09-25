import { describe, expect, it } from 'vitest';
import { SIGNAL_TYPES, type SignalType } from '@signals/types';
import {
  IndicatorContext,
  InvalidSignalParametersError,
  completedCandles,
  computeIndicatorSnapshot,
  detectTransition,
  ema,
  evaluateSignal,
  macd,
  parseSignalParameters,
  rsi,
  signalCatalog,
  signalName,
  signalTitle,
} from '../src';
import { MINUTE, candlesFrom, randomWalk } from './helpers';

/** Evaluate a signal at every prefix of the series, returning indices where it fired. */
function firingIndices(
  type: SignalType,
  closes: number[],
  params: unknown = {},
  volumes?: number[],
) {
  const candles = candlesFrom(closes, volumes);
  const parameters = parseSignalParameters(type, params);
  const fired: number[] = [];
  for (let end = 1; end <= candles.length; end++) {
    const r = evaluateSignal({ signalType: type, parameters, candles: candles.slice(0, end) });
    if (r.triggered) fired.push(end - 1);
  }
  return fired;
}

/** Independent crossover detection straight from the indicator arrays. */
function crossIndices(a: (number | null)[], b: (number | null)[], dir: 'up' | 'down') {
  const out: number[] = [];
  for (let i = 1; i < a.length; i++) {
    const [pa, pb, ca, cb] = [a[i - 1], b[i - 1], a[i], b[i]];
    if (pa == null || pb == null || ca == null || cb == null) continue;
    if (dir === 'up' ? pa <= pb && ca > cb : pa >= pb && ca < cb) out.push(i);
  }
  return out;
}

// Falls 120 -> ~100 then rallies: guarantees an EMA 9/21 bullish cross in the rally.
const V_SHAPE = [
  ...Array.from({ length: 40 }, (_, i) => 120 - i * 0.5),
  ...Array.from({ length: 25 }, (_, i) => 100.5 + i * 1.2),
];

describe('detectTransition (fire once on false -> true)', () => {
  it('spec example: EMA9 99/EMA21 100 -> 102/101 fires, then 103/102 does not', () => {
    const cond = (ema9: number, ema21: number) => ema9 > ema21;
    const first = detectTransition(cond(99, 100), cond(102, 101));
    expect(first).toBe(true);
    const second = detectTransition(cond(102, 101), cond(103, 102));
    expect(second).toBe(false);
  });

  it('never fires on unknown state', () => {
    expect(detectTransition(null, true)).toBe(false);
    expect(detectTransition(true, true)).toBe(false);
    expect(detectTransition(false, false)).toBe(false);
    expect(detectTransition(false, null)).toBe(false);
  });
});

describe('EMA crossover detection', () => {
  it('fires exactly on the candle where EMA 9 crosses above EMA 21', () => {
    const fired = firingIndices('EMA_BULLISH_CROSS', V_SHAPE);
    const expected = crossIndices(ema(V_SHAPE, 9), ema(V_SHAPE, 21), 'up');
    expect(expected.length).toBeGreaterThan(0);
    expect(fired).toEqual(expected);
  });

  it('does not fire again while EMA 9 stays above EMA 21', () => {
    const fired = firingIndices('EMA_BULLISH_CROSS', V_SHAPE);
    expect(fired).toHaveLength(1);
    const candles = candlesFrom(V_SHAPE);
    const params = parseSignalParameters('EMA_BULLISH_CROSS');
    const afterCross = evaluateSignal({
      signalType: 'EMA_BULLISH_CROSS',
      parameters: params,
      candles: candles.slice(0, fired[0]! + 2),
    });
    expect(afterCross.active).toBe(true);
    expect(afterCross.previousActive).toBe(true);
    expect(afterCross.triggered).toBe(false);
  });

  it('produces an explainable event payload', () => {
    const idx = firingIndices('EMA_BULLISH_CROSS', V_SHAPE)[0]!;
    const r = evaluateSignal({
      signalType: 'EMA_BULLISH_CROSS',
      parameters: parseSignalParameters('EMA_BULLISH_CROSS'),
      candles: candlesFrom(V_SHAPE).slice(0, idx + 1),
    });
    expect(r.triggered).toBe(true);
    expect(r.price).toBe(V_SHAPE[idx]);
    expect(r.values.ema9!).toBeGreaterThan(r.values.ema21!);
    expect(r.values).toHaveProperty('rsi14');
    expect(r.values).toHaveProperty('volumeRatio');
    expect(r.message).toBe(`EMA 9 crossed above EMA 21 at $${V_SHAPE[idx]!.toFixed(2)}`);
    expect(r.candleTime).toBe(idx * MINUTE);
  });

  it('bearish cross matches independent detection on a random walk', () => {
    const closes = randomWalk(300, 5);
    expect(firingIndices('EMA_BEARISH_CROSS', closes)).toEqual(
      crossIndices(ema(closes, 9), ema(closes, 21), 'down'),
    );
  });

  it('supports EMA 20/50 via parameters', () => {
    const closes = randomWalk(300, 9);
    expect(firingIndices('EMA_BULLISH_CROSS', closes, { fast: 20, slow: 50 })).toEqual(
      crossIndices(ema(closes, 20), ema(closes, 50), 'up'),
    );
  });

  it('price crosses EMA 20 in both directions', () => {
    const closes = randomWalk(250, 13);
    const e20 = ema(closes, 20);
    expect(firingIndices('PRICE_CROSS_ABOVE_EMA', closes)).toEqual(crossIndices(closes, e20, 'up'));
    expect(firingIndices('PRICE_CROSS_BELOW_EMA', closes)).toEqual(
      crossIndices(closes, e20, 'down'),
    );
  });

  it('uses persisted previous state instead of a revised previous candle', () => {
    const idx = firingIndices('EMA_BULLISH_CROSS', V_SHAPE)[0]!;
    const r = evaluateSignal({
      signalType: 'EMA_BULLISH_CROSS',
      parameters: parseSignalParameters('EMA_BULLISH_CROSS'),
      candles: candlesFrom(V_SHAPE).slice(0, idx + 1),
      previousActive: true, // state says we were already above on the prior candle
    });
    expect(r.active).toBe(true);
    expect(r.triggered).toBe(false);
  });
});

describe('RSI threshold crossing', () => {
  // Choppy start (RSI ~50), steady decline drives RSI < 30, then a sharp rally pushes it > 70.
  const closes = [
    ...Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 0.5 : -0.5)),
    ...Array.from({ length: 30 }, (_, i) => 100 - i * 0.8 + (i % 3 === 0 ? 0.3 : 0)),
    ...Array.from({ length: 30 }, (_, i) => 76.8 + i * 1.1 - (i % 4 === 0 ? 0.4 : 0)),
  ];
  const r = rsi(closes, 14);
  const level = (lvl: number) => r.map(() => lvl);

  it('RSI < 30 fires when RSI enters oversold', () => {
    expect(firingIndices('RSI_OVERSOLD', closes)).toEqual(crossIndices(r, level(30), 'down'));
    expect(firingIndices('RSI_OVERSOLD', closes).length).toBeGreaterThan(0);
  });

  it('RSI crosses upward through 30', () => {
    const fired = firingIndices('RSI_CROSS_UP', closes);
    expect(fired).toEqual(crossIndices(r, level(30), 'up'));
    expect(fired.length).toBeGreaterThan(0);
    for (const i of fired) {
      expect(r[i - 1]!).toBeLessThanOrEqual(30);
      expect(r[i]!).toBeGreaterThan(30);
    }
  });

  it('RSI > 70 fires once when RSI enters overbought', () => {
    const fired = firingIndices('RSI_OVERBOUGHT', closes);
    expect(fired).toEqual(crossIndices(r, level(70), 'up'));
    expect(fired).toHaveLength(1);
  });

  it('RSI crosses downward through 70', () => {
    const topThenDrop = [...closes, ...Array.from({ length: 15 }, (_, i) => 108 - i * 1.5)];
    const r2 = rsi(topThenDrop, 14);
    const fired = firingIndices('RSI_CROSS_DOWN', topThenDrop);
    expect(fired.length).toBeGreaterThan(0);
    expect(fired).toEqual(
      crossIndices(
        r2,
        r2.map(() => 70),
        'down',
      ),
    );
  });

  it('message states the level and current RSI', () => {
    const idx = firingIndices('RSI_CROSS_UP', closes)[0]!;
    const res = evaluateSignal({
      signalType: 'RSI_CROSS_UP',
      parameters: parseSignalParameters('RSI_CROSS_UP'),
      candles: candlesFrom(closes).slice(0, idx + 1),
    });
    expect(res.message).toMatch(/^RSI 14 crossed upward through 30 \(now \d+\.\d\)$/);
  });
});

describe('MACD crossover', () => {
  const closes = randomWalk(300, 17);
  const m = macd(closes);

  it('bullish and bearish crossovers match the MACD/signal arrays', () => {
    const bull = firingIndices('MACD_BULLISH_CROSS', closes);
    const bear = firingIndices('MACD_BEARISH_CROSS', closes);
    expect(bull).toEqual(crossIndices(m.macd, m.signal, 'up'));
    expect(bear).toEqual(crossIndices(m.macd, m.signal, 'down'));
    expect(bull.length).toBeGreaterThan(0);
    expect(bear.length).toBeGreaterThan(0);
  });

  it('crossovers alternate between bullish and bearish', () => {
    const events = [
      ...firingIndices('MACD_BULLISH_CROSS', closes).map((i) => ({ i, t: 'bull' })),
      ...firingIndices('MACD_BEARISH_CROSS', closes).map((i) => ({ i, t: 'bear' })),
    ].sort((a, b) => a.i - b.i);
    for (let k = 1; k < events.length; k++) expect(events[k]!.t).not.toBe(events[k - 1]!.t);
  });

  it('is not evaluable before the signal line exists', () => {
    const res = evaluateSignal({
      signalType: 'MACD_BULLISH_CROSS',
      parameters: parseSignalParameters('MACD_BULLISH_CROSS'),
      candles: candlesFrom(closes.slice(0, 34)),
    });
    expect(res.evaluable).toBe(false);
    expect(res.triggered).toBe(false);
  });
});

describe('volume spike', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + (i % 2));
  const base = Array.from({ length: 30 }, () => 1_000_000);

  it('fires when volume > 1.5x the previous 20-candle average', () => {
    const vols = [...base];
    vols[25] = 1_600_000;
    expect(firingIndices('VOLUME_SPIKE', closes, {}, vols)).toEqual([25]);
    const res = evaluateSignal({
      signalType: 'VOLUME_SPIKE',
      parameters: parseSignalParameters('VOLUME_SPIKE'),
      candles: candlesFrom(closes, vols).slice(0, 26),
    });
    expect(res.values.volumeRatio).toBeCloseTo(1.6, 6);
    expect(res.message).toBe(
      'Volume 1.6M is 1.6x the 20-period average (1.0M), above the 1.5x threshold',
    );
  });

  it('2x threshold ignores a 1.6x candle but catches a 2.5x candle', () => {
    const vols = [...base];
    vols[22] = 1_600_000;
    vols[27] = 2_500_000;
    expect(firingIndices('VOLUME_SPIKE', closes, { multiplier: 2 }, vols)).toEqual([27]);
  });

  it('consecutive spike candles fire only once', () => {
    const vols = [...base];
    vols[24] = 3_000_000;
    vols[25] = 3_000_000;
    expect(firingIndices('VOLUME_SPIKE', closes, {}, vols)).toEqual([24]);
  });

  it('abnormal volume uses a z-score against the baseline', () => {
    const noisy = base.map((v, i) => v + (i % 5) * 50_000);
    noisy[26] = 5_000_000;
    expect(firingIndices('VOLUME_ANOMALY', closes, {}, noisy)).toEqual([26]);
    const res = evaluateSignal({
      signalType: 'VOLUME_ANOMALY',
      parameters: parseSignalParameters('VOLUME_ANOMALY'),
      candles: candlesFrom(closes, noisy).slice(0, 27),
    });
    expect(res.values.volumeZScore!).toBeGreaterThan(3);
    expect(res.message).toMatch(/^Abnormal volume: 5\.0M is \d+\.\d standard deviations above/);
  });
});

describe('price signals', () => {
  const closes = [95, 98, 99, 101, 103, 99, 102];

  it('price above X fires on each upward crossing only', () => {
    expect(firingIndices('PRICE_ABOVE', closes, { threshold: 100 })).toEqual([3, 6]);
  });

  it('price below X', () => {
    expect(firingIndices('PRICE_BELOW', closes, { threshold: 100 })).toEqual([5]);
  });

  it('percentage move up/down over the lookback window', () => {
    const series = [100, 100.5, 104, 104.2, 99, 98.9, 95];
    expect(firingIndices('PCT_MOVE_UP', series, { threshold: 3 })).toEqual([2]);
    expect(firingIndices('PCT_MOVE_DOWN', series, { threshold: 3 })).toEqual([4, 6]);
    expect(firingIndices('PCT_MOVE_DOWN', series, { threshold: 5, lookback: 3 })).toEqual([6]);
  });
});

describe('parameters and catalog', () => {
  it('fills defaults', () => {
    expect(parseSignalParameters('EMA_BULLISH_CROSS')).toEqual({ fast: 9, slow: 21 });
    expect(parseSignalParameters('MACD_BULLISH_CROSS')).toEqual({ fast: 12, slow: 26, signal: 9 });
    expect(parseSignalParameters('VOLUME_SPIKE', { multiplier: 2 })).toEqual({
      multiplier: 2,
      period: 20,
    });
  });

  it('rejects invalid or unknown parameters', () => {
    expect(() => parseSignalParameters('EMA_BULLISH_CROSS', { fast: 21, slow: 9 })).toThrow(
      InvalidSignalParametersError,
    );
    expect(() => parseSignalParameters('PRICE_ABOVE', {})).toThrow(InvalidSignalParametersError);
    expect(() => parseSignalParameters('PRICE_ABOVE', { threshold: 1, bogus: 2 })).toThrow(
      InvalidSignalParametersError,
    );
  });

  it('every signal type is registered and evaluates without throwing', () => {
    const candles = candlesFrom(randomWalk(200, 99));
    const context = new IndicatorContext(candles);
    expect(signalCatalog().map((c) => c.signalType)).toEqual([...SIGNAL_TYPES]);
    for (const entry of signalCatalog()) {
      const params = parseSignalParameters(entry.signalType, entry.defaultParameters);
      const res = evaluateSignal({ signalType: entry.signalType, parameters: params, context });
      expect(res.evaluable).toBe(true);
      expect(typeof res.active).toBe('boolean');
    }
  });

  it('names and titles are human readable', () => {
    expect(signalName('EMA_BULLISH_CROSS', { fast: 9, slow: 21 })).toBe('EMA 9/21 Bullish Cross');
    expect(signalName('VOLUME_SPIKE', { multiplier: 1.5, period: 20 })).toBe(
      'Volume > 1.5x 20-period average',
    );
    expect(signalTitle('NVDA', 'EMA_BULLISH_CROSS')).toBe('NVDA — EMA Bullish Cross');
  });
});

describe('completed candles & snapshot', () => {
  it('drops the in-progress candle', () => {
    const candles = candlesFrom([1, 2, 3]);
    const now = 2 * MINUTE + 30_000; // halfway through the third candle
    expect(completedCandles(candles, '1m', now).map((c) => c.close)).toEqual([1, 2]);
    expect(completedCandles(candles, '1m', 3 * MINUTE).map((c) => c.close)).toEqual([1, 2, 3]);
  });

  it('snapshot exposes all indicators used by the detail screen', () => {
    const snap = computeIndicatorSnapshot(candlesFrom(randomWalk(120, 4)));
    for (const key of [
      'ema9',
      'ema20',
      'ema21',
      'ema50',
      'rsi14',
      'macd',
      'macdSignal',
      'avgVolume20',
    ] as const) {
      expect(snap[key]).not.toBeNull();
    }
  });
});
