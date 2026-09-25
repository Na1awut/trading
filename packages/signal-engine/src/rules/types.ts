import type { z } from 'zod';
import type { SignalCategory, SignalParameters, SignalType, SignalValues } from '@signals/types';
import type { IndicatorContext } from '../indicators/context';

/**
 * A rule is expressed as a LEVEL condition evaluated per candle index
 * (e.g. "EMA 9 > EMA 21"). The engine turns it into an EVENT by firing only on a
 * false -> true transition between consecutive completed candles, which is what makes
 * crossovers, threshold crossings and "fire once" semantics uniform across all rules.
 */
export interface PreparedRule {
  /** `null` = not enough data at this index to decide. */
  condition(index: number): boolean | null;
  /** Rule-specific values at this index, recorded with the event for explainability. */
  values(index: number): SignalValues;
}

export interface MessageInput<P> {
  params: P;
  values: SignalValues;
  price: number;
  currency: string;
}

export interface SignalRule<P extends SignalParameters = SignalParameters> {
  type: SignalType;
  category: SignalCategory;
  /** Short label, e.g. "EMA Bullish Cross" - used in notification titles. */
  label: string;
  /** Educational description of what the signal measures. */
  description: string;
  parametersSchema: z.ZodType<P>;
  defaultParameters: P;
  /** Display name for a configured instance, e.g. "EMA 9/21 Bullish Cross". */
  name(params: P): string;
  /** Minimum number of completed candles needed to evaluate the latest AND previous candle. */
  minCandles(params: P): number;
  prepare(ctx: IndicatorContext, params: P): PreparedRule;
  /** Plain-language explanation of why the signal fired. */
  message(input: MessageInput<P>): string;
}

/** Registry-erased rule type. Parameters are validated by `parametersSchema` at the boundary. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySignalRule = SignalRule<any>;

export function at(series: ReadonlyArray<number | null>, index: number): number | null {
  if (index < 0 || index >= series.length) return null;
  return series[index] ?? null;
}

/** Compare two possibly-missing values; `null` when either side is missing. */
export function gt(a: number | null, b: number | null): boolean | null {
  return a === null || b === null ? null : a > b;
}

export function lt(a: number | null, b: number | null): boolean | null {
  return a === null || b === null ? null : a < b;
}
