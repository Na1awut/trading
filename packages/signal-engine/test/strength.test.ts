import { describe, expect, it } from 'vitest';
import { SIGNAL_TYPES } from '@signals/types';
import {
  DEFAULT_STRENGTH_MODEL,
  IndicatorContext,
  createSignalContext,
  evaluateSignal,
  parseSignalParameters,
  scoreSignal,
  strengthModelFromList,
} from '../src';
import { candlesFrom } from './helpers';

// Accelerating rise: RSI > 50, close > EMA 50, MACD histogram > 0. Last candle volume 2x.
const closes = Array.from({ length: 120 }, (_, i) => 100 + 0.01 * i * i);
const spikeVol = closes.map((_, i) => (i === closes.length - 1 ? 2_000_000 : 1_000_000));
const flatVol = closes.map(() => 1_000_000);
const last = closes.length - 1;

describe('signal strength (technical-condition agreement)', () => {
  it('counts the trigger plus every agreeing confirmation', () => {
    const s = scoreSignal(
      'EMA_BULLISH_CROSS',
      new IndicatorContext(candlesFrom(closes, spikeVol)),
      last,
    );
    expect(s).toMatchObject({ score: 5, maxScore: 5, level: 'HIGH', direction: 'up' });
    expect(s.components.map((c) => [c.name, c.met])).toEqual([
      ['trigger', true],
      ['volume', true],
      ['rsi', true],
      ['trend', true],
      ['macd', true],
    ]);
  });

  it('directional confirmations disagree for a downward signal in an uptrend', () => {
    const s = scoreSignal(
      'EMA_BEARISH_CROSS',
      new IndicatorContext(candlesFrom(closes, spikeVol)),
      last,
    );
    // only trigger + volume (volume is not directional)
    expect(s).toMatchObject({ score: 2, maxScore: 5, level: 'MEDIUM', direction: 'down' });
  });

  it('volume confirmation needs >= 1.5x the 20-period average', () => {
    const s = scoreSignal(
      'EMA_BULLISH_CROSS',
      new IndicatorContext(candlesFrom(closes, flatVol)),
      last,
    );
    expect(s.components.find((c) => c.name === 'volume')).toMatchObject({ met: false });
    expect(s.score).toBe(4);
  });

  it('does not count a confirmation that restates the trigger', () => {
    const ctx = new IndicatorContext(candlesFrom(closes, spikeVol));
    expect(scoreSignal('RSI_CROSS_UP', ctx, last).components.map((c) => c.name)).toEqual([
      'trigger',
      'volume',
      'trend',
      'macd',
    ]);
    expect(scoreSignal('MACD_BULLISH_CROSS', ctx, last).components.map((c) => c.name)).toEqual([
      'trigger',
      'volume',
      'rsi',
      'trend',
    ]);
    // volume signals have no direction -> only the trigger itself
    expect(scoreSignal('VOLUME_SPIKE', ctx, last)).toMatchObject({
      score: 1,
      maxScore: 1,
      level: 'LOW',
      direction: 'none',
    });
  });

  it('is configurable (SIGNAL_STRENGTH_CONFIRMATIONS)', () => {
    const model = strengthModelFromList('volume, rsi, astrology');
    expect(model.confirmations).toEqual(['volume', 'rsi']);
    const s = scoreSignal(
      'EMA_BULLISH_CROSS',
      new IndicatorContext(candlesFrom(closes, spikeVol)),
      last,
      model,
    );
    expect(s).toMatchObject({ score: 3, maxScore: 3, level: 'HIGH' });
    const strict = { ...DEFAULT_STRENGTH_MODEL, thresholds: { medium: 3, high: 5 } };
    expect(
      scoreSignal(
        'EMA_BEARISH_CROSS',
        new IndicatorContext(candlesFrom(closes, spikeVol)),
        last,
        strict,
      ).level,
    ).toBe('LOW');
  });

  it('treats missing indicator history as not confirming', () => {
    const short = closes.slice(0, 25);
    const s = scoreSignal(
      'PRICE_ABOVE',
      new IndicatorContext(candlesFrom(short, flatVol.slice(0, 25))),
      24,
    );
    expect(s.components.find((c) => c.name === 'trend')).toMatchObject({ met: false });
  });

  it('is attached to evidence only when a signal fires', () => {
    const candles = candlesFrom([95, 98, 99, 101], undefined);
    const params = parseSignalParameters('PRICE_ABOVE', { threshold: 100 });
    const fired = evaluateSignal({
      signalType: 'PRICE_ABOVE',
      parameters: params,
      context: createSignalContext('X', '5m', candles),
    });
    expect(fired.triggered).toBe(true);
    expect(fired.evidence!.strength).toMatchObject({
      direction: 'up',
      components: expect.any(Array),
    });
    const quiet = evaluateSignal({
      signalType: 'PRICE_ABOVE',
      parameters: params,
      candles: candles.slice(0, 3),
    });
    expect(quiet.evidence!.strength).toBeUndefined();
  });

  it('never uses buy/sell language', () => {
    const ctx = new IndicatorContext(candlesFrom(closes, spikeVol));
    for (const type of SIGNAL_TYPES) {
      const s = scoreSignal(type, ctx, last);
      expect(JSON.stringify(s)).not.toMatch(/buy|sell/i);
    }
  });
});
