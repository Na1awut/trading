import { describe, expect, it } from 'vitest';
import type { NormalizedCandle, Timeframe } from '@signals/types';
import { auditCandles, fieldDiff, sanitizeForFixture, usEquitySession } from '../src';

const H = 3_600_000;
const M = 60_000;

/** Regular-session bars for a New York trading day. `utcOffsetH` = 4 (EDT) or 5 (EST). */
function sessionBars(
  date: string,
  utcOffsetH: number,
  tfMin: number,
  opts: { firstMinute?: number; mislabel?: boolean } = {},
) {
  const [y, m, d] = date.split('-').map(Number);
  const open = Date.UTC(y!, m! - 1, d!, 9, 30) + (opts.mislabel ? 0 : utcOffsetH * H);
  const out: number[] = [];
  for (let t = open + (opts.firstMinute ?? 0) * M; t < open + 390 * M; t += tfMin * M) out.push(t);
  return out;
}

function candles(times: number[], timeframe: Timeframe): NormalizedCandle[] {
  return times.map((time) => ({
    symbol: 'AAPL',
    timeframe,
    time,
    timestamp: new Date(time).toISOString(),
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
  }));
}

describe('usEquitySession (America/New_York, DST-aware)', () => {
  it('classifies regular, extended, overnight and weekend bars', () => {
    expect(usEquitySession(Date.UTC(2026, 8, 25, 13, 30))).toBe('regular'); // 09:30 EDT
    expect(usEquitySession(Date.UTC(2026, 8, 25, 13, 25))).toBe('extended'); // 09:25 pre-market
    expect(usEquitySession(Date.UTC(2026, 8, 25, 20, 0))).toBe('extended'); // 16:00 after-hours
    expect(usEquitySession(Date.UTC(2026, 8, 25, 3, 0))).toBe('overnight'); // 23:00 previous day
    expect(usEquitySession(Date.UTC(2026, 8, 26, 15, 0))).toBe('weekend'); // Saturday
    expect(usEquitySession(Date.UTC(2026, 0, 15, 14, 30))).toBe('regular'); // 09:30 EST (winter)
    expect(usEquitySession(Date.UTC(2026, 0, 15, 13, 30))).toBe('extended'); // 08:30 EST
  });
});

describe('auditCandles: timestamp semantics', () => {
  const now = Date.UTC(2026, 8, 26, 12); // Saturday - market closed
  it('recognises UTC timestamps from the session open (EDT)', () => {
    const times = [...sessionBars('2026-09-24', 4, 5), ...sessionBars('2026-09-25', 4, 5)];
    const a = auditCandles(candles(times, '5m'), '5m', now, { assetKind: 'us-equity' });
    expect(a.timestampSemantics.verdict).toBe('utc');
    expect(a.firstBarLocalTimes).toEqual(['09:30']);
    expect(a.sessions).toEqual({ regular: 156, extended: 0, overnight: 0, weekend: 0 });
    expect(a.utcGridAligned).toBe(true);
    expect(a.gaps).toBe(1); // overnight gap between the two sessions
  });

  it('detects New York wall-clock times mislabelled as UTC', () => {
    const times = [
      ...sessionBars('2026-09-24', 4, 5, { mislabel: true }),
      ...sessionBars('2026-09-25', 4, 5, { mislabel: true }),
    ];
    const a = auditCandles(candles(times, '5m'), '5m', now, { assetKind: 'us-equity' });
    expect(a.timestampSemantics.verdict).toBe('exchange-local');
  });

  it('stays correct across the March DST change (open moves from 14:30Z to 13:30Z)', () => {
    const times = [
      ...sessionBars('2026-03-05', 5, 15),
      ...sessionBars('2026-03-06', 5, 15),
      ...sessionBars('2026-03-09', 4, 15),
    ];
    const a = auditCandles(candles(times, '15m'), '15m', Date.UTC(2026, 2, 10), {
      assetKind: 'us-equity',
    });
    expect(a.timestampSemantics.verdict).toBe('utc');
    expect(a.firstBarLocalTimes).toEqual(['09:30']);
  });

  it('flags hourly bars anchored to the 09:30 open (off the UTC hour grid)', () => {
    const times = [...sessionBars('2026-09-24', 4, 60), ...sessionBars('2026-09-25', 4, 60)];
    const a = auditCandles(candles(times, '1h'), '1h', now, { assetKind: 'us-equity' });
    expect(a.gridOffsetsMinutes).toEqual([30]);
    expect(a.utcGridAligned).toBe(false);
  });

  it('counts extended-hours bars when the vendor includes them', () => {
    const pre = Array.from({ length: 6 }, (_, i) => Date.UTC(2026, 8, 25, 12, 30) + i * 5 * M); // 08:30-08:55 EDT
    const a = auditCandles(candles([...pre, ...sessionBars('2026-09-25', 4, 5)], '5m'), '5m', now, {
      assetKind: 'us-equity',
    });
    expect(a.sessions!.extended).toBe(6);
  });

  it('treats daily bars as calendar dates', () => {
    const times = [Date.UTC(2026, 8, 24), Date.UTC(2026, 8, 25)];
    expect(auditCandles(candles(times, '1d'), '1d', now).timestampSemantics.verdict).toBe(
      'date-only',
    );
  });

  it('checks recency for 24/7 markets', () => {
    const t = Date.UTC(2026, 8, 26, 11, 58);
    const a = auditCandles(candles([t - 60_000, t], '1m'), '1m', now, { assetKind: 'crypto' });
    expect(a.timestampSemantics.verdict).toBe('utc');
  });
});

describe('auditCandles: completion', () => {
  it('reports the in-progress bar and any future bar', () => {
    const now = Date.UTC(2026, 8, 25, 14, 37, 30);
    const times = [
      Date.UTC(2026, 8, 25, 14, 25),
      Date.UTC(2026, 8, 25, 14, 30),
      Date.UTC(2026, 8, 25, 14, 35),
      Date.UTC(2026, 8, 25, 14, 40),
    ];
    const a = auditCandles(candles(times, '5m'), '5m', now, { graceMs: 5_000 });
    expect(a.incompleteCount).toBe(2);
    expect(a.futureCount).toBe(1);
    expect(a.newest).toMatchObject({ complete: false });
  });
});

describe('sanitizeForFixture', () => {
  it('removes identifying keys and API keys and keeps the newest N values', () => {
    const raw = {
      meta: { symbol: 'AAPL', interval: '5min', request_id: 'r-123', account_id: 42 },
      values: Array.from({ length: 50 }, (_, i) => ({ datetime: `t${i}`, close: String(i) })),
      apikey: 'SECRET-KEY',
      user_email: 'me@example.com',
      note: 'echo SECRET-KEY',
      status: 'ok',
    };
    const clean = sanitizeForFixture(raw, { maxValues: 3, secrets: ['SECRET-KEY'] }) as Record<
      string,
      unknown
    >;
    expect(clean).toEqual({
      meta: { symbol: 'AAPL', interval: '5min' },
      values: [
        { datetime: 't47', close: '47' },
        { datetime: 't48', close: '48' },
        { datetime: 't49', close: '49' },
      ],
      note: 'echo [REDACTED]',
      status: 'ok',
    });
  });

  it('diffs field names between a live response and a recorded fixture', () => {
    expect(fieldDiff({ a: 1, b: 2, c: 3 }, { a: 1, d: 4 })).toEqual({
      missing: ['d'],
      added: ['b', 'c'],
    });
  });
});
