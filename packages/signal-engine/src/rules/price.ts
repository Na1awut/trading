import { z } from 'zod';
import { formatNumber, formatPrice } from '../format';
import { at, gt, lt, type SignalRule } from './types';

const thresholdSchema = z.object({ threshold: z.number().positive() }).strict();
type ThresholdParams = z.infer<typeof thresholdSchema>;

export const priceAbove: SignalRule<ThresholdParams> = {
  type: 'PRICE_ABOVE',
  category: 'PRICE',
  label: 'Price Above',
  description: 'Fires when a candle closes above the target price after closing at or below it.',
  parametersSchema: thresholdSchema,
  defaultParameters: { threshold: 100 },
  name: (p) => `Price above ${formatPrice(p.threshold)}`,
  minCandles: () => 2,
  prepare: (ctx, p) => ({
    condition: (i) => gt(at(ctx.closes, i), p.threshold),
    values: () => ({ threshold: p.threshold }),
  }),
  message: ({ params, price, currency }) =>
    `Price closed above ${formatPrice(params.threshold, currency)} at ${formatPrice(price, currency)}`,
};

export const priceBelow: SignalRule<ThresholdParams> = {
  type: 'PRICE_BELOW',
  category: 'PRICE',
  label: 'Price Below',
  description: 'Fires when a candle closes below the target price after closing at or above it.',
  parametersSchema: thresholdSchema,
  defaultParameters: { threshold: 100 },
  name: (p) => `Price below ${formatPrice(p.threshold)}`,
  minCandles: () => 2,
  prepare: (ctx, p) => ({
    condition: (i) => lt(at(ctx.closes, i), p.threshold),
    values: () => ({ threshold: p.threshold }),
  }),
  message: ({ params, price, currency }) =>
    `Price closed below ${formatPrice(params.threshold, currency)} at ${formatPrice(price, currency)}`,
};

const pctSchema = z
  .object({
    /** Percent, always positive: 3 means +3% for PCT_MOVE_UP and -3% for PCT_MOVE_DOWN. */
    threshold: z.number().positive().max(100),
    /** Number of candles to measure the move over (1 = vs previous close). */
    lookback: z.number().int().min(1).max(500).default(1),
  })
  .strict();
type PctParams = z.infer<typeof pctSchema>;

function pctChange(closes: number[], i: number, lookback: number): number | null {
  const now = at(closes, i);
  const then = at(closes, i - lookback);
  if (now === null || then === null || then === 0) return null;
  return ((now - then) / then) * 100;
}

const candles = (n: number) => (n === 1 ? '1 candle' : `${n} candles`);

export const pctMoveUp: SignalRule<PctParams> = {
  type: 'PCT_MOVE_UP',
  category: 'PRICE',
  label: 'Percentage Move Up',
  description: 'Fires when price rises at least X% over the lookback window.',
  parametersSchema: pctSchema,
  defaultParameters: { threshold: 3, lookback: 1 },
  name: (p) => `Move up ≥ ${p.threshold}% (${candles(p.lookback)})`,
  minCandles: (p) => p.lookback + 2,
  prepare: (ctx, p) => ({
    condition: (i) => {
      const pct = pctChange(ctx.closes, i, p.lookback);
      return pct === null ? null : pct >= p.threshold;
    },
    values: (i) => ({ pctChange: pctChange(ctx.closes, i, p.lookback), threshold: p.threshold }),
  }),
  message: ({ params, values, price, currency }) =>
    `Price rose ${formatNumber(values.pctChange ?? 0)}% over the last ${candles(params.lookback)} ` +
    `(threshold ${params.threshold}%) to ${formatPrice(price, currency)}`,
};

export const pctMoveDown: SignalRule<PctParams> = {
  type: 'PCT_MOVE_DOWN',
  category: 'PRICE',
  label: 'Percentage Move Down',
  description: 'Fires when price falls at least X% over the lookback window.',
  parametersSchema: pctSchema,
  defaultParameters: { threshold: 3, lookback: 1 },
  name: (p) => `Move down ≥ ${p.threshold}% (${candles(p.lookback)})`,
  minCandles: (p) => p.lookback + 2,
  prepare: (ctx, p) => ({
    condition: (i) => {
      const pct = pctChange(ctx.closes, i, p.lookback);
      return pct === null ? null : pct <= -p.threshold;
    },
    values: (i) => ({ pctChange: pctChange(ctx.closes, i, p.lookback), threshold: -p.threshold }),
  }),
  message: ({ params, values, price, currency }) =>
    `Price fell ${formatNumber(Math.abs(values.pctChange ?? 0))}% over the last ` +
    `${candles(params.lookback)} (threshold ${params.threshold}%) to ${formatPrice(price, currency)}`,
};
