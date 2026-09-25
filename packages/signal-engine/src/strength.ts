import type { SignalStrength, SignalStrengthBreakdown, SignalType } from '@signals/types';
import type { IndicatorContext } from './indicators/context';
import { formatNumber } from './format';
import { at } from './rules/types';

/**
 * Which way the triggering condition points. Describes price/momentum MOVEMENT only
 * ("RSI rose above 70" is 'up') - it is not a buy/sell judgement.
 */
export type SignalDirection = 'up' | 'down' | 'none';

export const SIGNAL_DIRECTIONS: Record<SignalType, SignalDirection> = {
  PRICE_ABOVE: 'up',
  PRICE_BELOW: 'down',
  PCT_MOVE_UP: 'up',
  PCT_MOVE_DOWN: 'down',
  EMA_BULLISH_CROSS: 'up',
  EMA_BEARISH_CROSS: 'down',
  PRICE_CROSS_ABOVE_EMA: 'up',
  PRICE_CROSS_BELOW_EMA: 'down',
  RSI_OVERBOUGHT: 'up',
  RSI_OVERSOLD: 'down',
  RSI_CROSS_UP: 'up',
  RSI_CROSS_DOWN: 'down',
  MACD_BULLISH_CROSS: 'up',
  MACD_BEARISH_CROSS: 'down',
  VOLUME_SPIKE: 'none',
  VOLUME_ANOMALY: 'none',
};

export type StrengthConfirmation = 'volume' | 'rsi' | 'trend' | 'macd';
export const ALL_CONFIRMATIONS: StrengthConfirmation[] = ['volume', 'rsi', 'trend', 'macd'];

export interface StrengthModel {
  /** Enabled confirmations (SIGNAL_STRENGTH_CONFIRMATIONS). */
  confirmations: StrengthConfirmation[];
  /** Points (trigger counts as 1) needed for MEDIUM / HIGH. */
  thresholds: { medium: number; high: number };
  volumeRatio: number;
  trendEmaPeriod: number;
}

export const DEFAULT_STRENGTH_MODEL: StrengthModel = {
  confirmations: ALL_CONFIRMATIONS,
  thresholds: { medium: 2, high: 3 },
  volumeRatio: 1.5,
  trendEmaPeriod: 50,
};

export function strengthModelFromList(list: string, base = DEFAULT_STRENGTH_MODEL): StrengthModel {
  const confirmations = list
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is StrengthConfirmation => (ALL_CONFIRMATIONS as string[]).includes(s));
  return { ...base, confirmations };
}

/** Confirmations that would merely restate the trigger are not counted for it. */
function redundant(type: SignalType, c: StrengthConfirmation): boolean {
  if (c === 'volume') return type === 'VOLUME_SPIKE' || type === 'VOLUME_ANOMALY';
  if (c === 'rsi') return type.startsWith('RSI_');
  if (c === 'macd') return type.startsWith('MACD_');
  return false;
}

/**
 * Score = 1 (the trigger) + number of enabled, applicable confirmations that agree with the
 * signal's direction at `index`. Level: LOW below `thresholds.medium`, MEDIUM, HIGH at
 * `thresholds.high`. Missing indicator data counts as "not met".
 */
export function scoreSignal(
  type: SignalType,
  ctx: IndicatorContext,
  index: number,
  model: StrengthModel = DEFAULT_STRENGTH_MODEL,
): SignalStrengthBreakdown {
  const direction = SIGNAL_DIRECTIONS[type];
  const components: SignalStrengthBreakdown['components'] = [
    { name: 'trigger', met: true, detail: 'Signal condition became true on a completed candle' },
  ];
  const up = direction === 'up';
  const word = up ? 'above' : 'below';

  if (direction !== 'none') {
    for (const c of model.confirmations) {
      if (redundant(type, c)) continue;
      if (c === 'volume') {
        const avg = at(ctx.volume(20).average, index);
        const vol = at(ctx.volumes, index);
        const ratio = avg && vol !== null ? vol / avg : null;
        components.push({
          name: 'volume',
          met: ratio !== null && ratio >= model.volumeRatio,
          detail: `Volume ${ratio === null ? 'n/a' : `${formatNumber(ratio, 1)}x`} the 20-period average (confirms at >= ${model.volumeRatio}x)`,
        });
      } else if (c === 'rsi') {
        const r = at(ctx.rsi(14), index);
        components.push({
          name: 'rsi',
          met: r !== null && (up ? r > 50 : r < 50),
          detail: `RSI 14 ${r === null ? 'n/a' : formatNumber(r, 1)} (confirms ${word} 50)`,
        });
      } else if (c === 'trend') {
        const e = at(ctx.ema(model.trendEmaPeriod), index);
        const close = at(ctx.closes, index);
        components.push({
          name: 'trend',
          met: e !== null && close !== null && (up ? close > e : close < e),
          detail: `Close ${close === null || e === null ? 'n/a' : `${formatNumber(close)} vs EMA ${model.trendEmaPeriod} ${formatNumber(e)}`} (confirms ${word})`,
        });
      } else if (c === 'macd') {
        const h = at(ctx.macd(12, 26, 9).histogram, index);
        components.push({
          name: 'macd',
          met: h !== null && (up ? h > 0 : h < 0),
          detail: `MACD histogram ${h === null ? 'n/a' : formatNumber(h, 3)} (confirms ${up ? 'above' : 'below'} 0)`,
        });
      }
    }
  }

  const score = components.filter((x) => x.met).length;
  const level: SignalStrength =
    score >= model.thresholds.high ? 'HIGH' : score >= model.thresholds.medium ? 'MEDIUM' : 'LOW';
  return { score, maxScore: components.length, level, direction, components };
}
