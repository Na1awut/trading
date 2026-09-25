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
