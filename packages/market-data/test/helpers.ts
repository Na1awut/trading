import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketDataLogger } from '../src';

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'twelvedata', name), 'utf8'));

export interface Reply {
  status?: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
  /** Throw a network error instead of responding. */
  networkError?: string;
  /** Never respond (until aborted) - simulates a hung connection. */
  hang?: boolean;
}

/** Fake fetch returning queued replies in order; records requested URLs. */
export function fakeFetch(replies: Reply[]) {
  const urls: URL[] = [];
  const fn = (async (input: URL | string, init?: RequestInit) => {
    urls.push(new URL(String(input)));
    const r = replies.shift();
    if (!r) throw new Error('fakeFetch: no reply queued');
    if (r.networkError) throw new TypeError(r.networkError);
    if (r.hang) {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      );
    }
    return new Response(r.raw ?? JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...r.headers },
    });
  }) as unknown as typeof fetch;
  return { fetch: fn, urls };
}

/** Logger that captures entries so tests can assert on (and scan for secrets in) logs. */
export function captureLogger() {
  const entries: { level: string; obj: object; msg?: string }[] = [];
  const log =
    (level: string) =>
    (obj: object, msg?: string): void => {
      entries.push({ level, obj, msg });
    };
  const logger: MarketDataLogger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
  return { logger, entries, text: () => JSON.stringify(entries) };
}
