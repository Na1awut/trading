import type { NormalizedCandle, Timeframe } from '@signals/types';
import { isCandleComplete, timeframeToMs } from '@signals/types';

/**
 * Live-validation analysers. Pure functions over NORMALISED candles, used by
 * `validate:market-data` to answer questions the documentation does not settle:
 * are timestamps really UTC, how are bars aligned, which sessions are included, and
 * does the newest candle arrive incomplete?
 */

export type SessionClass = 'regular' | 'extended' | 'overnight' | 'weekend';

/** US equity session of a bar, from its open time in America/New_York (DST-aware). */
export function usEquitySession(timeMs: number): SessionClass {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hourCycle: 'h23',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(timeMs))
      .map((p) => [p.type, p.value]),
  );
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return 'weekend';
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return 'regular';
  if (minutes >= 4 * 60 && minutes < 20 * 60) return 'extended';
  return 'overnight';
}

function nyLocalHHMM(timeMs: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timeMs));
}

export interface CandleAudit {
  timeframe: Timeframe;
  count: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  ascending: boolean;
  /** Most common spacing between consecutive candles (ms). */
  spacingModeMs: number | null;
  /** Consecutive pairs further apart than one timeframe (sessions, weekends, gaps). */
  gaps: number;
  /** Distinct open-time offsets from the UTC grid, in minutes (e.g. [30] = bars start at :30). */
  gridOffsetsMinutes: number[];
  /** True when every bar starts on the UTC timeframe grid our clock maths assumes. */
  utcGridAligned: boolean;
  /** Candles whose open time is in the future (should be 0). */
  futureCount: number;
  /** Candles not yet complete at `now` (incl. grace) - the in-progress bar(s). */
  incompleteCount: number;
  newest: { timestamp: string; ageSeconds: number; complete: boolean } | null;
  /** US equities only: session mix and the local (New York) time of each day's first bar. */
  sessions?: Record<SessionClass, number>;
  firstBarLocalTimes?: string[];
  /** Best inference of timestamp semantics, with the evidence used. */
  timestampSemantics: {
    verdict: 'utc' | 'exchange-local' | 'date-only' | 'inconclusive';
    reason: string;
  };
}

export function auditCandles(
  candles: ReadonlyArray<NormalizedCandle>,
  timeframe: Timeframe,
  nowMs: number,
  opts: { graceMs?: number; assetKind?: 'us-equity' | 'crypto' | 'other' } = {},
): CandleAudit {
  const tf = timeframeToMs(timeframe);
  const times = candles.map((c) => c.time);
  const spacings = times.slice(1).map((t, i) => t - times[i]!);
  const counts = new Map<number, number>();
  for (const d of spacings) counts.set(d, (counts.get(d) ?? 0) + 1);
  const spacingModeMs = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const offsets = [...new Set(times.map((t) => Math.round((((t % tf) + tf) % tf) / 60_000)))].sort(
    (a, b) => a - b,
  );
  const newestCandle = candles.at(-1);

  const audit: CandleAudit = {
    timeframe,
    count: candles.length,
    firstTimestamp: candles[0]?.timestamp ?? null,
    lastTimestamp: newestCandle?.timestamp ?? null,
    ascending: spacings.every((d) => d > 0),
    spacingModeMs,
    gaps: spacings.filter((d) => d > tf).length,
    gridOffsetsMinutes: offsets,
    utcGridAligned: offsets.length === 0 || (offsets.length === 1 && offsets[0] === 0),
    futureCount: times.filter((t) => t > nowMs).length,
    incompleteCount: candles.filter(
      (c) => !isCandleComplete(c, timeframe, nowMs, opts.graceMs ?? 0),
    ).length,
    newest: newestCandle
      ? {
          timestamp: newestCandle.timestamp,
          ageSeconds: Math.round((nowMs - newestCandle.time) / 1000),
          complete: isCandleComplete(newestCandle, timeframe, nowMs, opts.graceMs ?? 0),
        }
      : null,
    timestampSemantics: { verdict: 'inconclusive', reason: 'no candles' },
  };

  if (candles.length === 0) return audit;

  if (timeframe === '1d') {
    const midnight = times.every((t) => t % 86_400_000 === 0);
    audit.timestampSemantics = midnight
      ? {
          verdict: 'date-only',
          reason: 'daily bars carry a calendar date (stored as 00:00 UTC of that date)',
        }
      : { verdict: 'inconclusive', reason: 'daily bars are not at 00:00 UTC' };
    return audit;
  }

  if (opts.assetKind === 'us-equity') {
    const sessions: Record<SessionClass, number> = {
      regular: 0,
      extended: 0,
      overnight: 0,
      weekend: 0,
    };
    for (const t of times) sessions[usEquitySession(t)]++;
    audit.sessions = sessions;
    // First bar of each UTC day, expressed in New York local time.
    const firstByDay = new Map<string, number>();
    for (const t of times) {
      const day = new Date(t).toISOString().slice(0, 10);
      if (!firstByDay.has(day)) firstByDay.set(day, t);
    }
    // Only days whose first bar we actually saw (skip a truncated first day).
    const firsts = [...firstByDay.values()].slice(1);
    audit.firstBarLocalTimes = [...new Set(firsts.map(nyLocalHHMM))];
    const utcHHMM = [...new Set(firsts.map((t) => new Date(t).toISOString().slice(11, 16)))];
    if (firsts.length === 0) {
      audit.timestampSemantics = {
        verdict: 'inconclusive',
        reason: 'need at least one complete trading day in the sample',
      };
    } else if (audit.firstBarLocalTimes.every((h) => h === '09:30' || h === '04:00')) {
      audit.timestampSemantics = {
        verdict: 'utc',
        reason: `each session's first bar is ${audit.firstBarLocalTimes.join('/')} New York time when read as UTC`,
      };
    } else if (utcHHMM.every((h) => h === '09:30' || h === '04:00')) {
      audit.timestampSemantics = {
        verdict: 'exchange-local',
        reason: `first bars read ${utcHHMM.join('/')} as UTC, i.e. New York wall-clock times labelled as UTC`,
      };
    } else {
      audit.timestampSemantics = {
        verdict: 'inconclusive',
        reason: `first bars at ${audit.firstBarLocalTimes.join(', ')} New York time`,
      };
    }
    return audit;
  }

  // 24/7 markets: the newest bar should be within ~2 intervals of now if timestamps are UTC.
  const age = nowMs - times.at(-1)!;
  audit.timestampSemantics =
    age >= -tf && age <= 3 * tf
      ? { verdict: 'utc', reason: `newest bar opened ${Math.round(age / 60_000)} min before now` }
      : {
          verdict: 'inconclusive',
          reason: `newest bar is ${Math.round(age / 60_000)} min from now`,
        };
  return audit;
}

const SENSITIVE_KEY =
  /api.?key|token|secret|password|passwd|account|request.?id|client.?id|user|email|plan|signature|credential/i;

/**
 * Prepare a raw vendor response for committing as a regression fixture: drops any key that
 * could identify an account or request (and any API key), and keeps only the newest
 * `maxValues` candles.
 */
export function sanitizeForFixture(
  body: unknown,
  opts: { maxValues?: number; secrets?: string[] } = {},
): unknown {
  const secrets = (opts.secrets ?? []).filter(Boolean);
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) {
      const arr = key === 'values' && opts.maxValues ? v.slice(-opts.maxValues) : v;
      return arr.map((x) => walk(x));
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => !SENSITIVE_KEY.test(k))
          .map(([k, x]) => [k, walk(x, k)]),
      );
    }
    if (typeof v === 'string') {
      let out = v;
      for (const s of secrets) out = out.split(s).join('[REDACTED]');
      return out;
    }
    return v;
  };
  return walk(body);
}

/** Field-level diff between a live response item and a recorded fixture item. */
export function fieldDiff(
  live: unknown,
  recorded: unknown,
): { missing: string[]; added: string[] } {
  const keys = (o: unknown) =>
    o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o as object) : [];
  const a = new Set(keys(live));
  const b = new Set(keys(recorded));
  return {
    missing: [...b].filter((k) => !a.has(k)).sort(),
    added: [...a].filter((k) => !b.has(k)).sort(),
  };
}
