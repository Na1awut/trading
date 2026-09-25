import type { PushMessage } from './types';

export const DEEP_LINK_SCHEME = 'stocksignals';

export interface SignalNotificationInput {
  eventId: string;
  ticker: string;
  /** Rule label, e.g. "EMA Bullish Cross". */
  label: string;
  /** Explanation, e.g. "EMA 9 crossed above EMA 21 at $182.30". */
  message: string;
  timeframe: string;
}

/**
 * Title: "NVDA — EMA Bullish Cross"
 * Body:  "EMA 9 crossed above EMA 21 at $182.30 (1h)"
 * Data:  deep link to the asset detail screen, opened when the user taps.
 */
export function buildSignalNotification(input: SignalNotificationInput): PushMessage {
  return {
    title: `${input.ticker} — ${input.label}`,
    body: `${input.message} (${input.timeframe})`,
    data: {
      type: 'signal',
      eventId: input.eventId,
      ticker: input.ticker,
      url: `${DEEP_LINK_SCHEME}://asset/${encodeURIComponent(input.ticker)}`,
    },
  };
}
