import type { Prisma } from '@prisma/client';
import { getRule, parseSignalParameters, signalName } from '@signals/signal-engine';
import type { SignalParameters, SignalType, Timeframe } from '@signals/types';
import type { Db } from '../client';

export interface PresetSpec {
  signalType: SignalType;
  parameters: SignalParameters;
  /** Subscribed AND enabled automatically when a ticker is added to a watchlist. */
  enabledByDefault: boolean;
}

/**
 * Preset signals offered for every watchlist ticker. Presets are shared definitions:
 * evaluated once per (ticker, timeframe, candle) no matter how many users subscribe.
 * Price thresholds / % moves are user-specific, so they are custom signals instead.
 */
export const PRESET_SIGNALS: PresetSpec[] = [
  { signalType: 'EMA_BULLISH_CROSS', parameters: { fast: 9, slow: 21 }, enabledByDefault: true },
  { signalType: 'EMA_BEARISH_CROSS', parameters: { fast: 9, slow: 21 }, enabledByDefault: true },
  { signalType: 'PRICE_CROSS_ABOVE_EMA', parameters: { period: 20 }, enabledByDefault: false },
  { signalType: 'PRICE_CROSS_BELOW_EMA', parameters: { period: 20 }, enabledByDefault: false },
  { signalType: 'EMA_BULLISH_CROSS', parameters: { fast: 20, slow: 50 }, enabledByDefault: false },
  { signalType: 'EMA_BEARISH_CROSS', parameters: { fast: 20, slow: 50 }, enabledByDefault: false },
  { signalType: 'RSI_OVERBOUGHT', parameters: { period: 14, level: 70 }, enabledByDefault: false },
  { signalType: 'RSI_OVERSOLD', parameters: { period: 14, level: 30 }, enabledByDefault: false },
  { signalType: 'RSI_CROSS_UP', parameters: { period: 14, level: 30 }, enabledByDefault: true },
  { signalType: 'RSI_CROSS_DOWN', parameters: { period: 14, level: 70 }, enabledByDefault: true },
  {
    signalType: 'MACD_BULLISH_CROSS',
    parameters: { fast: 12, slow: 26, signal: 9 },
    enabledByDefault: true,
  },
  {
    signalType: 'MACD_BEARISH_CROSS',
    parameters: { fast: 12, slow: 26, signal: 9 },
    enabledByDefault: true,
  },
  {
    signalType: 'VOLUME_SPIKE',
    parameters: { multiplier: 1.5, period: 20 },
    enabledByDefault: false,
  },
  { signalType: 'VOLUME_SPIKE', parameters: { multiplier: 2, period: 20 }, enabledByDefault: true },
  { signalType: 'VOLUME_ANOMALY', parameters: { period: 20, stdDevs: 3 }, enabledByDefault: false },
];

export function canonicalParams(params: SignalParameters): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))),
  );
}

export function presetKey(
  ticker: string,
  timeframe: Timeframe,
  type: SignalType,
  params: SignalParameters,
) {
  return `${ticker}:${timeframe}:${type}:${canonicalParams(params)}`;
}

export async function ensurePresetDefinition(
  db: Db,
  ticker: string,
  timeframe: Timeframe,
  spec: Pick<PresetSpec, 'signalType' | 'parameters'>,
) {
  const parameters = parseSignalParameters(spec.signalType, spec.parameters);
  const rule = getRule(spec.signalType);
  const key = presetKey(ticker, timeframe, spec.signalType, parameters);
  return db.signalDefinition.upsert({
    where: { presetKey: key },
    update: {},
    create: {
      presetKey: key,
      name: signalName(spec.signalType, parameters),
      description: rule.description,
      category: rule.category,
      signalType: spec.signalType,
      ticker,
      timeframe,
      parameters: parameters as Prisma.InputJsonObject,
    },
  });
}

/** Subscribe a user to every preset for a ticker (idempotent; keeps existing toggles). */
export async function subscribeToPresets(
  db: Db,
  userId: string,
  ticker: string,
  timeframe: Timeframe,
  presets: PresetSpec[] = PRESET_SIGNALS,
): Promise<void> {
  for (const spec of presets) {
    const def = await ensurePresetDefinition(db, ticker, timeframe, spec);
    await db.signalSubscription.upsert({
      where: { userId_signalDefinitionId: { userId, signalDefinitionId: def.id } },
      update: {},
      create: { userId, signalDefinitionId: def.id, enabled: spec.enabledByDefault },
    });
  }
}
