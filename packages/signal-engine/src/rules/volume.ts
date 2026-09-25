import { z } from 'zod';
import { formatCompact, formatNumber } from '../format';
import { at, type SignalRule } from './types';

const spikeSchema = z
  .object({
    multiplier: z.number().min(1).max(100).default(1.5),
    period: z.number().int().min(2).max(200).default(20),
  })
  .strict();
type SpikeParams = z.infer<typeof spikeSchema>;

export const volumeSpike: SignalRule<SpikeParams> = {
  type: 'VOLUME_SPIKE',
  category: 'VOLUME',
  label: 'Volume Spike',
  description:
    'Candle volume exceeds a multiple of the average volume of the previous N candles ' +
    '(the current candle is excluded from its own baseline).',
  parametersSchema: spikeSchema,
  defaultParameters: { multiplier: 1.5, period: 20 },
  name: (p) => `Volume > ${p.multiplier}x ${p.period}-period average`,
  minCandles: (p) => p.period + 2,
  prepare: (ctx, p) => {
    const { average } = ctx.volume(p.period);
    return {
      condition: (i) => {
        const avg = at(average, i);
        const vol = at(ctx.volumes, i);
        if (avg === null || vol === null || avg <= 0) return null;
        return vol > avg * p.multiplier;
      },
      values: (i) => {
        const avg = at(average, i);
        const vol = at(ctx.volumes, i);
        return {
          volume: vol,
          [`avgVolume${p.period}`]: avg,
          volumeRatio: avg && vol !== null ? vol / avg : null,
          multiplier: p.multiplier,
        };
      },
    };
  },
  message: ({ params, values }) =>
    `Volume ${formatCompact(values.volume ?? 0)} is ${formatNumber(values.volumeRatio ?? 0, 1)}x the ` +
    `${params.period}-period average (${formatCompact(values[`avgVolume${params.period}`] ?? 0)}), ` +
    `above the ${params.multiplier}x threshold`,
};

const anomalySchema = z
  .object({
    period: z.number().int().min(5).max(200).default(20),
    stdDevs: z.number().min(1).max(10).default(3),
  })
  .strict();
type AnomalyParams = z.infer<typeof anomalySchema>;

export const volumeAnomaly: SignalRule<AnomalyParams> = {
  type: 'VOLUME_ANOMALY',
  category: 'VOLUME',
  label: 'Abnormal Volume',
  description:
    'Statistically unusual volume: the candle volume is at least K standard deviations ' +
    'above the average of the previous N candles (z-score).',
  parametersSchema: anomalySchema,
  defaultParameters: { period: 20, stdDevs: 3 },
  name: (p) => `Abnormal volume (≥ ${p.stdDevs}σ over ${p.period})`,
  minCandles: (p) => p.period + 2,
  prepare: (ctx, p) => {
    const { average, stdDev } = ctx.volume(p.period);
    const zScore = (i: number): number | null => {
      const avg = at(average, i);
      const sd = at(stdDev, i);
      const vol = at(ctx.volumes, i);
      if (avg === null || sd === null || vol === null) return null;
      if (sd === 0) return vol > avg ? Number.POSITIVE_INFINITY : 0;
      return (vol - avg) / sd;
    };
    return {
      condition: (i) => {
        const z = zScore(i);
        return z === null ? null : z >= p.stdDevs;
      },
      values: (i) => {
        const avg = at(average, i);
        const vol = at(ctx.volumes, i);
        const z = zScore(i);
        return {
          volume: vol,
          [`avgVolume${p.period}`]: avg,
          volumeRatio: avg && vol !== null ? vol / avg : null,
          volumeZScore: z !== null && Number.isFinite(z) ? z : null,
        };
      },
    };
  },
  message: ({ params, values }) =>
    `Abnormal volume: ${formatCompact(values.volume ?? 0)} is ` +
    (values.volumeZScore !== null && values.volumeZScore !== undefined
      ? `${formatNumber(values.volumeZScore, 1)} standard deviations`
      : 'far') +
    ` above the ${params.period}-period average (${formatCompact(
      values[`avgVolume${params.period}`] ?? 0,
    )})`,
};
