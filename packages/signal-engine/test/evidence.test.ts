import { describe, expect, it } from 'vitest';
import { SignalEvidenceSchema } from '@signals/types';
import { createSignalContext, evaluateSignal, parseSignalParameters, rsi } from '../src';
import { candlesFrom } from './helpers';

// Falls then rallies: EMA 9 crosses above EMA 21 during the rally.
const V_SHAPE = [
  ...Array.from({ length: 40 }, (_, i) => 120 - i * 0.5),
  ...Array.from({ length: 25 }, (_, i) => 100.5 + i * 1.2),
];

function firstTrigger(
  type: Parameters<typeof parseSignalParameters>[0],
  closes: number[],
  volumes?: number[],
) {
  const candles = candlesFrom(closes, volumes, Date.UTC(2026, 8, 25, 9, 0));
  const parameters = parseSignalParameters(type, type === 'PRICE_ABOVE' ? { threshold: 100 } : {});
  for (let end = 2; end <= candles.length; end++) {
    const context = createSignalContext('NVDA', '5m', candles.slice(0, end));
    const r = evaluateSignal({ signalType: type, parameters, context });
    if (r.triggered) return r;
  }
  throw new Error(`${type} never triggered`);
}

describe('structured signal evidence', () => {
  it('EMA bullish cross: previous EMA9 <= EMA21, current EMA9 > EMA21, plus the candle', () => {
    const r = firstTrigger('EMA_BULLISH_CROSS', V_SHAPE);
    const e = SignalEvidenceSchema.parse(r.evidence); // valid against the shared schema
    expect(e).toMatchObject({
      version: 1,
      type: 'EMA_BULLISH_CROSS',
      symbol: 'NVDA',
      timeframe: '5m',
      parameters: { fast: 9, slow: 21 },
      condition: { previous: false, current: true },
    });
    expect(e.previous.ema9!).toBeLessThanOrEqual(e.previous.ema21!);
    expect(e.current.ema9!).toBeGreaterThan(e.current.ema21!);
    expect(e.candle.close).toBe(r.price);
    expect(e.candle.timestamp).toBe(new Date(r.candleTime!).toISOString());
    expect(e.previousCandle!.timestamp < e.candle.timestamp).toBe(true);
    expect(e.context).toHaveProperty('rsi14');
    expect(e.context).toHaveProperty('volumeRatio');
  });

  it('RSI crossing up through 30 records RSI on both candles', () => {
    const closes = [
      ...Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 0.5 : -0.5)),
      ...Array.from({ length: 30 }, (_, i) => 100 - i * 0.8),
      ...Array.from({ length: 15 }, (_, i) => 76.8 + i * 1.1),
    ];
    const r = firstTrigger('RSI_CROSS_UP', closes);
    expect(r.evidence!.previous.rsi14!).toBeLessThanOrEqual(30);
    expect(r.evidence!.current.rsi14!).toBeGreaterThan(30);
    // matches the indicator itself
    const series = rsi(closes, 14);
    expect(r.evidence!.current.rsi14).toBeCloseTo(series[closes.indexOf(r.price!)]!, 3);
  });

  it('volume spike records volume, baseline and ratio before and at the spike', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + (i % 2));
    const vols = Array.from({ length: 30 }, () => 1_000_000);
    vols[25] = 2_000_000;
    const r = firstTrigger('VOLUME_SPIKE', closes, vols);
    expect(r.evidence!.previous).toMatchObject({ volume: 1_000_000, volumeRatio: 1 });
    expect(r.evidence!.current).toMatchObject({
      volume: 2_000_000,
      avgVolume20: 1_000_000,
      volumeRatio: 2,
    });
    expect(r.evidence!.candle.volume).toBe(2_000_000);
  });

  it('price threshold evidence includes the close on both candles', () => {
    const r = firstTrigger('PRICE_ABOVE', [95, 98, 99, 101]);
    // PRICE_ABOVE requires threshold; default parameters in catalog use 100
    expect(r.evidence).toMatchObject({
      previous: { close: 99, threshold: 100 },
      current: { close: 101, threshold: 100 },
    });
  });

  it('a plain IndicatorContext still works (symbol/timeframe unknown)', () => {
    const candles = candlesFrom(V_SHAPE);
    const r = evaluateSignal({
      signalType: 'EMA_BULLISH_CROSS',
      parameters: parseSignalParameters('EMA_BULLISH_CROSS'),
      candles,
    });
    expect(r.evidence).toMatchObject({ symbol: null, timeframe: null });
  });
});
