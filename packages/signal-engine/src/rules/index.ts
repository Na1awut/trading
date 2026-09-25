import type { SignalCatalogEntry, SignalParameters, SignalType } from '@signals/types';
import { SIGNAL_TYPES } from '@signals/types';
import { emaBearishCross, emaBullishCross, priceCrossAboveEma, priceCrossBelowEma } from './moving-average';
import {
  macdBearishCross,
  macdBullishCross,
  rsiCrossDown,
  rsiCrossUp,
  rsiOverbought,
  rsiOversold,
} from './momentum';
import { pctMoveDown, pctMoveUp, priceAbove, priceBelow } from './price';
import type { AnySignalRule } from './types';
import { volumeAnomaly, volumeSpike } from './volume';

export * from './types';

/** Every signal type maps to exactly one rule. Adding a type = add a rule here. */
export const SIGNAL_RULES: Record<SignalType, AnySignalRule> = {
  PRICE_ABOVE: priceAbove,
  PRICE_BELOW: priceBelow,
  PCT_MOVE_UP: pctMoveUp,
  PCT_MOVE_DOWN: pctMoveDown,
  EMA_BULLISH_CROSS: emaBullishCross,
  EMA_BEARISH_CROSS: emaBearishCross,
  PRICE_CROSS_ABOVE_EMA: priceCrossAboveEma,
  PRICE_CROSS_BELOW_EMA: priceCrossBelowEma,
  RSI_OVERBOUGHT: rsiOverbought,
  RSI_OVERSOLD: rsiOversold,
  RSI_CROSS_UP: rsiCrossUp,
  RSI_CROSS_DOWN: rsiCrossDown,
  MACD_BULLISH_CROSS: macdBullishCross,
  MACD_BEARISH_CROSS: macdBearishCross,
  VOLUME_SPIKE: volumeSpike,
  VOLUME_ANOMALY: volumeAnomaly,
};

export function getRule(type: SignalType): AnySignalRule {
  return SIGNAL_RULES[type];
}

export class InvalidSignalParametersError extends Error {
  constructor(
    readonly signalType: SignalType,
    readonly issues: string[],
  ) {
    super(`Invalid parameters for ${signalType}: ${issues.join('; ')}`);
    this.name = 'InvalidSignalParametersError';
  }
}

/** Validate user-supplied parameters and fill in defaults. Throws InvalidSignalParametersError. */
export function parseSignalParameters(type: SignalType, raw: unknown = {}): SignalParameters {
  const rule = getRule(type);
  const result = rule.parametersSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new InvalidSignalParametersError(
      type,
      result.error.issues.map((i) => `${i.path.join('.') || 'parameters'}: ${i.message}`),
    );
  }
  return result.data as SignalParameters;
}

export function signalName(type: SignalType, params: SignalParameters): string {
  return getRule(type).name(params);
}

export function signalCatalog(): SignalCatalogEntry[] {
  return SIGNAL_TYPES.map((type) => {
    const rule = getRule(type);
    return {
      signalType: type,
      category: rule.category,
      label: rule.label,
      description: rule.description,
      defaultParameters: rule.defaultParameters,
    };
  });
}
