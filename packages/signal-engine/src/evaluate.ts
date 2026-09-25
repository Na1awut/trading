import type {
  Candle,
  IndicatorSnapshot,
  SignalCategory,
  SignalParameters,
  SignalType,
  SignalValues,
  Timeframe,
} from '@signals/types';
import { isCandleComplete } from '@signals/types';
import { IndicatorContext } from './indicators/context';
import { getRule } from './rules';
import { at } from './rules/types';

/**
 * Transition detector: a signal fires only when its condition goes false -> true.
 * Unknown (`null`, e.g. not enough history) never fires, so a freshly created signal
 * whose condition is already true does not alert until it resets and triggers again.
 */
export function detectTransition(previous: boolean | null, current: boolean | null): boolean {
  return previous === false && current === true;
}

/** Keep only candles whose interval has fully elapsed. Input must be sorted ascending. */
export function completedCandles(
  candles: ReadonlyArray<Candle>,
  timeframe: Timeframe,
  nowMs: number,
): Candle[] {
  return candles.filter((c) => isCandleComplete(c, timeframe, nowMs));
}

export interface EvaluateSignalInput {
  signalType: SignalType;
  /** Already validated with `parseSignalParameters`. */
  parameters: SignalParameters;
  /** COMPLETED candles only, ascending by time. Ignored when `context` is given. */
  candles?: ReadonlyArray<Candle>;
  /** Shared indicator cache - pass one per (symbol, timeframe) when evaluating many signals. */
  context?: IndicatorContext;
  /**
   * Persisted condition state for the previous candle, if the caller has it (worker state
   * table). Preferred over recomputing so that a vendor revising an old candle cannot make
   * an already-fired signal fire again.
   */
  previousActive?: boolean | null;
  currency?: string;
}

export interface SignalEvaluation {
  signalType: SignalType;
  category: SignalCategory;
  label: string;
  /** False when there are not enough completed candles to evaluate. */
  evaluable: boolean;
  previousActive: boolean | null;
  active: boolean | null;
  triggered: boolean;
  /** Open time (epoch ms) of the latest completed candle evaluated. */
  candleTime: number | null;
  price: number | null;
  /** Rule values plus standard context (close, RSI 14, volume ratio) for explanations. */
  values: SignalValues;
  message: string | null;
}

export function evaluateSignal(input: EvaluateSignalInput): SignalEvaluation {
  const rule = getRule(input.signalType);
  const ctx = input.context ?? new IndicatorContext(input.candles ?? []);
  const last = ctx.length - 1;
  const base = {
    signalType: input.signalType,
    category: rule.category,
    label: rule.label,
  };

  if (ctx.length < rule.minCandles(input.parameters)) {
    return {
      ...base,
      evaluable: false,
      previousActive: null,
      active: null,
      triggered: false,
      candleTime: ctx.candles[last]?.time ?? null,
      price: ctx.candles[last]?.close ?? null,
      values: {},
      message: null,
    };
  }

  const prepared = rule.prepare(ctx, input.parameters);
  const active = prepared.condition(last);
  const previousActive =
    input.previousActive !== undefined ? input.previousActive : prepared.condition(last - 1);
  const triggered = detectTransition(previousActive, active);
  const candle = ctx.candles[last]!;
  const values = roundValues({ ...contextValues(ctx, last), ...prepared.values(last) });

  return {
    ...base,
    evaluable: true,
    previousActive,
    active,
    triggered,
    candleTime: candle.time,
    price: candle.close,
    values,
    message: triggered
      ? rule.message({
          params: input.parameters,
          values,
          price: candle.close,
          currency: input.currency ?? 'USD',
        })
      : null,
  };
}

/** Values attached to every event so the user sees the wider picture, not just the trigger. */
function contextValues(ctx: IndicatorContext, i: number): SignalValues {
  const { average } = ctx.volume(20);
  const avg = at(average, i);
  const vol = at(ctx.volumes, i);
  return {
    close: at(ctx.closes, i),
    rsi14: round(at(ctx.rsi(14), i)),
    volume: vol,
    avgVolume20: round(avg),
    volumeRatio: round(avg && vol !== null ? vol / avg : null),
  };
}

function roundValues(values: SignalValues): SignalValues {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, round(v)]));
}

function round(v: number | null, decimals = 4): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** Latest indicator values for display (asset detail screen). Input: completed candles. */
export function computeIndicatorSnapshot(
  candles: ReadonlyArray<Candle> | IndicatorContext,
): IndicatorSnapshot {
  const ctx = candles instanceof IndicatorContext ? candles : new IndicatorContext(candles);
  const i = ctx.length - 1;
  const m = ctx.macd(12, 26, 9);
  const { average } = ctx.volume(20);
  const vol = at(ctx.volumes, i);
  const avg = at(average, i);
  return {
    close: at(ctx.closes, i),
    ema9: round(at(ctx.ema(9), i)),
    ema20: round(at(ctx.ema(20), i)),
    ema21: round(at(ctx.ema(21), i)),
    ema50: round(at(ctx.ema(50), i)),
    rsi14: round(at(ctx.rsi(14), i)),
    macd: round(at(m.macd, i)),
    macdSignal: round(at(m.signal, i)),
    macdHistogram: round(at(m.histogram, i)),
    volume: vol,
    avgVolume20: round(avg),
    volumeRatio: round(avg && vol !== null ? vol / avg : null),
  };
}

/** Notification title, e.g. "NVDA — EMA Bullish Cross". */
export function signalTitle(ticker: string, signalType: SignalType): string {
  return `${ticker} — ${getRule(signalType).label}`;
}
