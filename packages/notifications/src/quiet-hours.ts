/**
 * Quiet hours in the user's IANA timezone. All inputs/outputs are UTC instants; local
 * wall-clock times ("22:00") are interpreted in `timeZone`, including DST transitions.
 *
 * Policy (Phase 2): a notification that would be sent during quiet hours is DELAYED until
 * the window ends; the SignalEvent itself is recorded and visible in history immediately.
 */

export interface QuietHoursResult {
  inQuietHours: boolean;
  /** UTC instant when the current quiet window ends (null when not in quiet hours). */
  endsAt: Date | null;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseHhmm(v: string | null | undefined): number | null {
  const m = v ? HHMM.exec(v) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(utcMs: number, tz: string): LocalParts {
  const parts = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset (local - UTC) in ms for `tz` at the given instant. */
function offsetMs(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** UTC instant for a local wall-clock time in `tz` (DST-aware). */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(first, tz);
  return second;
}

export function quietHoursStatus(
  nowMs: number,
  start: string | null | undefined,
  end: string | null | undefined,
  timeZone: string,
): QuietHoursResult {
  const s = parseHhmm(start);
  const e = parseHhmm(end);
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  if (s === null || e === null || s === e) return { inQuietHours: false, endsAt: null };

  const local = localParts(nowMs, tz);
  const minutes = local.hour * 60 + local.minute;
  const overnight = s > e; // e.g. 22:00 -> 07:00
  const inQuiet = overnight ? minutes >= s || minutes < e : minutes >= s && minutes < e;
  if (!inQuiet) return { inQuietHours: false, endsAt: null };

  // The window ends today, unless it is an overnight window and we are before midnight.
  const endsTomorrow = overnight && minutes >= s;
  const endDate = new Date(
    Date.UTC(local.year, local.month - 1, local.day + (endsTomorrow ? 1 : 0)),
  );
  const endsAt = zonedTimeToUtc(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth() + 1,
    endDate.getUTCDate(),
    Math.floor(e / 60),
    e % 60,
    tz,
  );
  return { inQuietHours: true, endsAt: new Date(endsAt) };
}
