import { describe, expect, it } from 'vitest';
import { isValidTimeZone, quietHoursStatus, zonedTimeToUtc } from '../src';

const at = (iso: string) => Date.parse(iso);
const q = (iso: string, start: string | null, end: string | null, tz: string) => {
  const r = quietHoursStatus(at(iso), start, end, tz);
  return { quiet: r.inQuietHours, endsAt: r.endsAt?.toISOString() ?? null };
};

describe('quiet hours (22:00 -> 07:00)', () => {
  it('Bangkok (UTC+7): before midnight -> ends 07:00 next local day', () => {
    // 23:30 local on Sep 25 = 16:30Z
    expect(q('2026-09-25T16:30:00Z', '22:00', '07:00', 'Asia/Bangkok')).toEqual({
      quiet: true,
      endsAt: '2026-09-26T00:00:00.000Z', // 07:00 Sep 26 local
    });
  });

  it('after midnight -> ends 07:00 the same local day', () => {
    // 06:59 local Sep 26 = 23:59Z Sep 25
    expect(q('2026-09-25T23:59:00Z', '22:00', '07:00', 'Asia/Bangkok')).toEqual({
      quiet: true,
      endsAt: '2026-09-26T00:00:00.000Z',
    });
  });

  it('boundaries: start is inclusive, end is exclusive', () => {
    expect(q('2026-09-25T15:00:00Z', '22:00', '07:00', 'Asia/Bangkok').quiet).toBe(true); // 22:00 local
    expect(q('2026-09-25T14:59:00Z', '22:00', '07:00', 'Asia/Bangkok').quiet).toBe(false); // 21:59
    expect(q('2026-09-26T00:00:00Z', '22:00', '07:00', 'Asia/Bangkok').quiet).toBe(false); // 07:00
  });

  it('uses the USER timezone, not the server one (same instant, different answers)', () => {
    const instant = '2026-09-25T16:30:00Z'; // 23:30 Bangkok, 12:30 New York, 01:30 Tokyo
    expect(q(instant, '22:00', '07:00', 'Asia/Bangkok').quiet).toBe(true);
    expect(q(instant, '22:00', '07:00', 'America/New_York').quiet).toBe(false);
    expect(q(instant, '22:00', '07:00', 'Asia/Tokyo')).toEqual({
      quiet: true,
      endsAt: '2026-09-25T22:00:00.000Z',
    });
  });

  it('handles DST: spring-forward night in New York ends at 07:00 EDT (UTC-4)', () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT. 23:00 EST Mar 7 = 04:00Z Mar 8.
    expect(q('2026-03-08T04:00:00Z', '22:00', '07:00', 'America/New_York')).toEqual({
      quiet: true,
      endsAt: '2026-03-08T11:00:00.000Z',
    });
  });

  it('handles DST: fall-back night in New York ends at 07:00 EST (UTC-5)', () => {
    // 2026-11-01 02:00 EDT -> 01:00 EST. 23:00 EDT Oct 31 = 03:00Z Nov 1.
    expect(q('2026-11-01T03:00:00Z', '22:00', '07:00', 'America/New_York')).toEqual({
      quiet: true,
      endsAt: '2026-11-01T12:00:00.000Z',
    });
  });

  it('supports same-day windows and treats start == end or missing values as off', () => {
    expect(q('2026-09-25T12:30:00Z', '12:00', '13:00', 'UTC')).toEqual({
      quiet: true,
      endsAt: '2026-09-25T13:00:00.000Z',
    });
    expect(q('2026-09-25T13:30:00Z', '12:00', '13:00', 'UTC').quiet).toBe(false);
    expect(q('2026-09-25T12:30:00Z', '12:00', '12:00', 'UTC').quiet).toBe(false);
    expect(q('2026-09-25T12:30:00Z', null, '13:00', 'UTC').quiet).toBe(false);
    expect(q('2026-09-25T12:30:00Z', '25:00', '13:00', 'UTC').quiet).toBe(false);
  });

  it('falls back to UTC for an invalid timezone', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(q('2026-09-25T23:00:00Z', '22:00', '07:00', 'Mars/Olympus')).toEqual({
      quiet: true,
      endsAt: '2026-09-26T07:00:00.000Z',
    });
  });

  it('zonedTimeToUtc converts local wall-clock time', () => {
    expect(new Date(zonedTimeToUtc(2026, 1, 15, 9, 30, 'Europe/London')).toISOString()).toBe(
      '2026-01-15T09:30:00.000Z',
    );
    expect(new Date(zonedTimeToUtc(2026, 7, 15, 9, 30, 'Europe/London')).toISOString()).toBe(
      '2026-07-15T08:30:00.000Z',
    );
  });
});
