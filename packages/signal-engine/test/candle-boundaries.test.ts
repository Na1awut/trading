import { describe, expect, it } from 'vitest';
import { isCandleComplete, latestClosedCandleOpenTime, type Timeframe } from '@signals/types';
import {
  IndicatorContext,
  completedCandles,
  evaluateSignal,
  parseSignalParameters,
  signalCatalog,
} from '../src';
import { candlesFrom, randomWalk } from './helpers';

const at = (iso: string) => Date.parse(iso);

describe('latest fully closed candle per timeframe', () => {
  const cases: [Timeframe, string, string][] = [
    ['1m', '2026-09-25T14:37:30Z', '2026-09-25T14:36:00Z'],
    ['1m', '2026-09-25T14:37:00Z', '2026-09-25T14:36:00Z'], // exactly at the boundary: 14:36 bar just closed
    ['1m', '2026-09-25T14:36:59.999Z', '2026-09-25T14:35:00Z'],
    ['5m', '2026-09-25T14:37:30Z', '2026-09-25T14:30:00Z'],
    ['5m', '2026-09-25T14:35:00Z', '2026-09-25T14:30:00Z'],
    ['5m', '2026-09-25T14:34:59.999Z', '2026-09-25T14:25:00Z'],
    ['15m', '2026-09-25T14:37:30Z', '2026-09-25T14:15:00Z'],
    ['15m', '2026-09-25T14:45:00Z', '2026-09-25T14:30:00Z'],
    ['1h', '2026-09-25T15:00:00Z', '2026-09-25T14:00:00Z'],
    ['1h', '2026-09-25T14:59:59.999Z', '2026-09-25T13:00:00Z'],
    ['1d', '2026-09-26T00:00:00Z', '2026-09-25T00:00:00Z'],
    ['1d', '2026-09-25T23:59:59.999Z', '2026-09-24T00:00:00Z'],
  ];
  it.each(cases)('%s at %s -> %s', (tf, now, expected) => {
    expect(new Date(latestClosedCandleOpenTime(at(now), tf)).toISOString()).toBe(
      new Date(expected).toISOString(),
    );
  });

  it('applies the vendor grace period before a candle counts as closed', () => {
    const now = at('2026-09-25T14:35:03Z'); // 3 s after the 14:30 bar ended
    expect(new Date(latestClosedCandleOpenTime(now, '5m', 5_000)).toISOString()).toBe(
      '2026-09-25T14:25:00.000Z',
    );
    expect(new Date(latestClosedCandleOpenTime(now + 2_000, '5m', 5_000)).toISOString()).toBe(
      '2026-09-25T14:30:00.000Z',
    );
    const bar = { time: at('2026-09-25T14:30:00Z') };
    expect(isCandleComplete(bar, '5m', now, 5_000)).toBe(false);
    expect(isCandleComplete(bar, '5m', now + 2_000, 5_000)).toBe(true);
    expect(isCandleComplete(bar, '5m', at('2026-09-25T14:35:00Z'))).toBe(true);
    expect(isCandleComplete(bar, '5m', at('2026-09-25T14:34:59.999Z'))).toBe(false);
  });

  it('completedCandles drops the in-progress and within-grace candles', () => {
    const start = at('2026-09-25T14:00:00Z');
    const candles = candlesFrom([1, 2, 3, 4], undefined, start); // 1m bars 14:00..14:03
    expect(completedCandles(candles, '1m', at('2026-09-25T14:03:30Z')).map((c) => c.close)).toEqual(
      [1, 2, 3],
    );
    expect(
      completedCandles(candles, '1m', at('2026-09-25T14:03:02Z'), 5_000).map((c) => c.close),
    ).toEqual([1, 2]);
  });
});

describe('indicator reuse within one evaluation', () => {
  it('computes each indicator series once for all signals sharing a context', () => {
    const context = new IndicatorContext(candlesFrom(randomWalk(200, 8)));
    for (const entry of signalCatalog()) {
      evaluateSignal({
        signalType: entry.signalType,
        parameters: parseSignalParameters(entry.signalType, entry.defaultParameters),
        context,
      });
    }
    // 16 signal types (+ standard context values) share: ema9/20/21, rsi14, macd, vol20
    expect(context.computedSeries.sort()).toEqual([
      'ema:20',
      'ema:21',
      'ema:9',
      'macd:12:26:9',
      'rsi:14',
      'vol:20',
    ]);
    const ema9 = context.ema(9);
    expect(context.ema(9)).toBe(ema9); // same array instance - not recomputed
  });

  it('evaluates an earlier candle by index (catch-up) identically to a truncated series', () => {
    const candles = candlesFrom(randomWalk(120, 3));
    const params = parseSignalParameters('MACD_BULLISH_CROSS');
    const context = new IndicatorContext(candles);
    for (const index of [60, 80, 100]) {
      const byIndex = evaluateSignal({
        signalType: 'MACD_BULLISH_CROSS',
        parameters: params,
        context,
        index,
      });
      const truncated = evaluateSignal({
        signalType: 'MACD_BULLISH_CROSS',
        parameters: params,
        candles: candles.slice(0, index + 1),
      });
      expect(byIndex).toEqual(truncated);
    }
  });
});
