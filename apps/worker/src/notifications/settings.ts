export interface DeliverySettings {
  /** Total send attempts per event (first send + retries). */
  maxAttempts: number;
  /** Delay after the first failed attempt; doubles each attempt. */
  retryBaseMs: number;
  retryMaxMs: number;
  /** A SENDING claim older than this is assumed to belong to a crashed worker. */
  sendingTimeoutMs: number;
  /** Undelivered events older than this are abandoned (no stale alerts). */
  maxAgeMs: number;
  sweepBatch: number;
  /** Minimum strength enforcement / quiet hours are applied at send time (see preferences). */
}

export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  maxAttempts: 5,
  retryBaseMs: 30_000,
  retryMaxMs: 30 * 60_000,
  sendingTimeoutMs: 120_000,
  maxAgeMs: 24 * 3_600_000,
  sweepBatch: 100,
};

/** Back-off after `attempt` failed attempts: base, 2x, 4x ... capped. */
export function retryDelayMs(attempt: number, s: DeliverySettings): number {
  return Math.min(s.retryBaseMs * 2 ** Math.max(0, attempt - 1), s.retryMaxMs);
}
