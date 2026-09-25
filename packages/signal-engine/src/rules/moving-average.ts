import { z } from 'zod';
import { formatPrice } from '../format';
import { at, gt, lt, type SignalRule } from './types';

const crossSchema = z
  .object({
    fast: z.number().int().min(2).max(400).default(9),
    slow: z.number().int().min(3).max(400).default(21),
  })
  .strict()
  .refine((p) => p.fast < p.slow, { message: 'fast period must be shorter than slow period' });
type CrossParams = z.infer<typeof crossSchema>;

// A crossover at the latest candle needs a defined EMA on the previous candle too.
const crossMin = (p: CrossParams) => p.slow + 1;

export const emaBullishCross: SignalRule<CrossParams> = {
  type: 'EMA_BULLISH_CROSS',
  category: 'MOVING_AVERAGE',
  label: 'EMA Bullish Cross',
  description:
    'The faster EMA closes above the slower EMA after being at or below it - short-term ' +
    'momentum has turned up relative to the longer trend.',
  parametersSchema: crossSchema,
  defaultParameters: { fast: 9, slow: 21 },
  name: (p) => `EMA ${p.fast}/${p.slow} Bullish Cross`,
  minCandles: crossMin,
  prepare: (ctx, p) => {
    const f = ctx.ema(p.fast);
    const s = ctx.ema(p.slow);
    return {
      condition: (i) => gt(at(f, i), at(s, i)),
      values: (i) => ({ [`ema${p.fast}`]: at(f, i), [`ema${p.slow}`]: at(s, i) }),
    };
  },
  message: ({ params, price, currency }) =>
    `EMA ${params.fast} crossed above EMA ${params.slow} at ${formatPrice(price, currency)}`,
};

export const emaBearishCross: SignalRule<CrossParams> = {
  type: 'EMA_BEARISH_CROSS',
  category: 'MOVING_AVERAGE',
  label: 'EMA Bearish Cross',
  description:
    'The faster EMA closes below the slower EMA after being at or above it - short-term ' +
    'momentum has turned down relative to the longer trend.',
  parametersSchema: crossSchema,
  defaultParameters: { fast: 9, slow: 21 },
  name: (p) => `EMA ${p.fast}/${p.slow} Bearish Cross`,
  minCandles: crossMin,
  prepare: (ctx, p) => {
    const f = ctx.ema(p.fast);
    const s = ctx.ema(p.slow);
    return {
      condition: (i) => lt(at(f, i), at(s, i)),
      values: (i) => ({ [`ema${p.fast}`]: at(f, i), [`ema${p.slow}`]: at(s, i) }),
    };
  },
  message: ({ params, price, currency }) =>
    `EMA ${params.fast} crossed below EMA ${params.slow} at ${formatPrice(price, currency)}`,
};

const priceEmaSchema = z.object({ period: z.number().int().min(2).max(400).default(20) }).strict();
type PriceEmaParams = z.infer<typeof priceEmaSchema>;

export const priceCrossAboveEma: SignalRule<PriceEmaParams> = {
  type: 'PRICE_CROSS_ABOVE_EMA',
  category: 'MOVING_AVERAGE',
  label: 'Price Crossed Above EMA',
  description: 'A candle closes above the EMA after closing at or below it.',
  parametersSchema: priceEmaSchema,
  defaultParameters: { period: 20 },
  name: (p) => `Price crosses above EMA ${p.period}`,
  minCandles: (p) => p.period + 1,
  prepare: (ctx, p) => {
    const e = ctx.ema(p.period);
    return {
      condition: (i) => gt(at(ctx.closes, i), at(e, i)),
      values: (i) => ({ [`ema${p.period}`]: at(e, i) }),
    };
  },
  message: ({ params, values, price, currency }) =>
    `Price closed above EMA ${params.period} (${formatPrice(values[`ema${params.period}`] ?? 0, currency)}) ` +
    `at ${formatPrice(price, currency)}`,
};

export const priceCrossBelowEma: SignalRule<PriceEmaParams> = {
  type: 'PRICE_CROSS_BELOW_EMA',
  category: 'MOVING_AVERAGE',
  label: 'Price Crossed Below EMA',
  description: 'A candle closes below the EMA after closing at or above it.',
  parametersSchema: priceEmaSchema,
  defaultParameters: { period: 20 },
  name: (p) => `Price crosses below EMA ${p.period}`,
  minCandles: (p) => p.period + 1,
  prepare: (ctx, p) => {
    const e = ctx.ema(p.period);
    return {
      condition: (i) => lt(at(ctx.closes, i), at(e, i)),
      values: (i) => ({ [`ema${p.period}`]: at(e, i) }),
    };
  },
  message: ({ params, values, price, currency }) =>
    `Price closed below EMA ${params.period} (${formatPrice(values[`ema${params.period}`] ?? 0, currency)}) ` +
    `at ${formatPrice(price, currency)}`,
};
