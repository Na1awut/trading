import type { PushMessage } from './types';

export const DEEP_LINK_SCHEME = 'stocksignals';

export interface SignalNotificationInput {
  eventId: string;
  symbol: string;
  signalType: string;
  /** Rule label, e.g. "EMA Bullish Cross". */
  label: string;
  /** Explanation, e.g. "EMA 9 crossed above EMA 21 at $182.30". */
  message: string;
  timeframe: string;
}

/** Deep link opened when the notification is tapped. */
export function signalEventDeepLink(eventId: string): string {
  return `${DEEP_LINK_SCHEME}://signals/events/${encodeURIComponent(eventId)}`;
}

/**
 * Title: "NVDA — EMA Bullish Cross"
 * Body:  "EMA 9 crossed above EMA 21 at $182.30 (5m)"
 * Data:  identifiers only (eventId, symbol, signalType, timeframe, url) - no user data,
 *        no tokens; the app fetches details from the API after authenticating.
 */
export function buildSignalNotification(input: SignalNotificationInput): PushMessage {
  return {
    title: `${input.symbol} — ${input.label}`,
    body: `${input.message} (${input.timeframe})`,
    data: {
      type: 'signal',
      eventId: input.eventId,
      symbol: input.symbol,
      signalType: input.signalType,
      timeframe: input.timeframe,
      url: signalEventDeepLink(input.eventId),
    },
    collapseId: input.eventId,
  };
}
