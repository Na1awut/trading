import { z } from 'zod';

export const SIGNAL_CATEGORIES = ['PRICE', 'MOVING_AVERAGE', 'MOMENTUM', 'VOLUME'] as const;
export const SignalCategorySchema = z.enum(SIGNAL_CATEGORIES);
export type SignalCategory = z.infer<typeof SignalCategorySchema>;

/** Human-readable label for a category, used in notifications and the UI. */
export const SIGNAL_CATEGORY_LABELS: Record<SignalCategory, string> = {
  PRICE: 'Price signal',
  MOVING_AVERAGE: 'Trend signal',
  MOMENTUM: 'Momentum signal',
  VOLUME: 'Volume signal',
};

/** Plural group headings for settings / configuration lists. */
export const SIGNAL_CATEGORY_GROUP_LABELS: Record<SignalCategory, string> = {
  PRICE: 'Price signals',
  MOVING_AVERAGE: 'Trend signals (moving averages)',
  MOMENTUM: 'Momentum signals (RSI, MACD)',
  VOLUME: 'Volume signals',
};

export const SIGNAL_TYPES = [
  // Price
  'PRICE_ABOVE',
  'PRICE_BELOW',
  'PCT_MOVE_UP',
  'PCT_MOVE_DOWN',
  // Moving averages
  'EMA_BULLISH_CROSS',
  'EMA_BEARISH_CROSS',
  'PRICE_CROSS_ABOVE_EMA',
  'PRICE_CROSS_BELOW_EMA',
  // RSI
  'RSI_OVERBOUGHT',
  'RSI_OVERSOLD',
  'RSI_CROSS_UP',
  'RSI_CROSS_DOWN',
  // MACD
  'MACD_BULLISH_CROSS',
  'MACD_BEARISH_CROSS',
  // Volume
  'VOLUME_SPIKE',
  'VOLUME_ANOMALY',
] as const;
export const SignalTypeSchema = z.enum(SIGNAL_TYPES);
export type SignalType = z.infer<typeof SignalTypeSchema>;

/** Numeric parameters only - keeps definitions serialisable and easy to validate. */
export type SignalParameters = Record<string, number>;
export const SignalParametersSchema = z.record(z.string(), z.number().finite());

/** Indicator/context values recorded with an event so the UI can explain it. */
export type SignalValues = Record<string, number | null>;
export const SignalValuesSchema = z.record(z.string(), z.number().nullable());

/** OHLCV snapshot of the candle a signal was evaluated on (UTC ISO timestamp). */
export const EvidenceCandleSchema = z.object({
  timestamp: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

/**
 * Structured proof of WHY a signal fired: the rule's values on the previous and current
 * completed candle (the false -> true transition), the triggering candle, parameters, and
 * context. Stored with every SignalEvent; UIs build explanations from it.
 */
export const SignalEvidenceSchema = z.object({
  version: z.literal(1),
  type: SignalTypeSchema,
  symbol: z.string().nullable(),
  timeframe: z.string().nullable(),
  parameters: SignalParametersSchema,
  /** Condition value on the previous and current candle (always false -> true for events). */
  condition: z.object({ previous: z.boolean().nullable(), current: z.boolean().nullable() }),
  previous: SignalValuesSchema,
  current: SignalValuesSchema,
  candle: EvidenceCandleSchema,
  previousCandle: EvidenceCandleSchema.nullable(),
  /** Standard context at the current candle: RSI 14, volume vs 20-period average, etc. */
  context: SignalValuesSchema,
});
export type SignalEvidence = z.infer<typeof SignalEvidenceSchema>;
