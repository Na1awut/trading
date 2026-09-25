import { z } from 'zod';
import { formatNumber } from '../format';
import { at, gt, lt, type SignalRule } from './types';

const rsiSchema = (defaultLevel: number) =>
  z
    .object({
      period: z.number().int().min(2).max(100).default(14),
      level: z.number().min(1).max(99).default(defaultLevel),
    })
    .strict();
type RsiParams = { period: number; level: number };

function rsiRule(
  type: 'RSI_OVERBOUGHT' | 'RSI_OVERSOLD' | 'RSI_CROSS_UP' | 'RSI_CROSS_DOWN',
  opts: {
    label: string;
    description: string;
    level: number;
    above: boolean;
    name: (p: RsiParams) => string;
    verb: string;
  },
): SignalRule<RsiParams> {
  return {
    type,
    category: 'MOMENTUM',
    label: opts.label,
    description: opts.description,
    parametersSchema: rsiSchema(opts.level),
    defaultParameters: { period: 14, level: opts.level },
    name: opts.name,
    // RSI is first defined at index `period`; we also need the previous candle.
    minCandles: (p) => p.period + 2,
    prepare: (ctx, p) => {
      const r = ctx.rsi(p.period);
      return {
        condition: (i) => (opts.above ? gt(at(r, i), p.level) : lt(at(r, i), p.level)),
        values: (i) => ({ [`rsi${p.period}`]: at(r, i), level: p.level }),
      };
    },
    message: ({ params, values }) =>
      `RSI ${params.period} ${opts.verb} ${params.level} (now ${formatNumber(
        values[`rsi${params.period}`] ?? 0,
        1,
      )})`,
  };
}

// Level condition + transition gives each of these a distinct meaning:
//   RSI_OVERBOUGHT  rsi > 70 becomes true  -> entered overbought
//   RSI_OVERSOLD    rsi < 30 becomes true  -> entered oversold
//   RSI_CROSS_UP    rsi > 30 becomes true  -> crossed upward through 30 (left oversold)
//   RSI_CROSS_DOWN  rsi < 70 becomes true  -> crossed downward through 70 (left overbought)
export const rsiOverbought = rsiRule('RSI_OVERBOUGHT', {
  label: 'RSI Overbought',
  description:
    'RSI rises above the overbought level (default 70): momentum is stretched to the upside.',
  level: 70,
  above: true,
  name: (p) => `RSI ${p.period} > ${p.level}`,
  verb: 'rose above',
});

export const rsiOversold = rsiRule('RSI_OVERSOLD', {
  label: 'RSI Oversold',
  description:
    'RSI falls below the oversold level (default 30): momentum is stretched to the downside.',
  level: 30,
  above: false,
  name: (p) => `RSI ${p.period} < ${p.level}`,
  verb: 'fell below',
});

export const rsiCrossUp = rsiRule('RSI_CROSS_UP', {
  label: 'RSI Crossed Up',
  description: 'RSI crosses upward through the level (default 30), often read as leaving oversold.',
  level: 30,
  above: true,
  name: (p) => `RSI ${p.period} crosses up through ${p.level}`,
  verb: 'crossed upward through',
});

export const rsiCrossDown = rsiRule('RSI_CROSS_DOWN', {
  label: 'RSI Crossed Down',
  description:
    'RSI crosses downward through the level (default 70), often read as leaving overbought.',
  level: 70,
  above: false,
  name: (p) => `RSI ${p.period} crosses down through ${p.level}`,
  verb: 'crossed downward through',
});

const macdSchema = z
  .object({
    fast: z.number().int().min(2).max(100).default(12),
    slow: z.number().int().min(3).max(200).default(26),
    signal: z.number().int().min(2).max(100).default(9),
  })
  .strict()
  .refine((p) => p.fast < p.slow, { message: 'fast period must be shorter than slow period' });
type MacdParams = z.infer<typeof macdSchema>;

// MACD line defined from index slow-1, signal from slow-1 + signal-1; plus previous candle.
const macdMin = (p: MacdParams) => p.slow + p.signal;

function macdRule(bullish: boolean): SignalRule<MacdParams> {
  return {
    type: bullish ? 'MACD_BULLISH_CROSS' : 'MACD_BEARISH_CROSS',
    category: 'MOMENTUM',
    label: bullish ? 'MACD Bullish Cross' : 'MACD Bearish Cross',
    description: bullish
      ? 'The MACD line crosses above its signal line: upside momentum is accelerating.'
      : 'The MACD line crosses below its signal line: downside momentum is accelerating.',
    parametersSchema: macdSchema,
    defaultParameters: { fast: 12, slow: 26, signal: 9 },
    name: (p) => `MACD (${p.fast},${p.slow},${p.signal}) ${bullish ? 'Bullish' : 'Bearish'} Cross`,
    minCandles: macdMin,
    prepare: (ctx, p) => {
      const m = ctx.macd(p.fast, p.slow, p.signal);
      return {
        condition: (i) => (bullish ? gt : lt)(at(m.macd, i), at(m.signal, i)),
        values: (i) => ({
          macd: at(m.macd, i),
          macdSignal: at(m.signal, i),
          macdHistogram: at(m.histogram, i),
        }),
      };
    },
    message: ({ params, values }) =>
      `MACD (${params.fast},${params.slow},${params.signal}) crossed ${bullish ? 'above' : 'below'} ` +
      `its signal line (MACD ${formatNumber(values.macd ?? 0, 3)} vs signal ${formatNumber(
        values.macdSignal ?? 0,
        3,
      )})`,
  };
}

export const macdBullishCross = macdRule(true);
export const macdBearishCross = macdRule(false);
