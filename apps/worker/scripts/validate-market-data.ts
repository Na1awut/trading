/**
 * LIVE market-data audit (Phase 3). Run with real credentials and egress:
 *
 *   MARKET_DATA_PROVIDER=real MARKET_DATA_VENDOR=twelvedata MARKET_DATA_API_KEY=... \
 *     pnpm --filter @signals/worker validate:market-data
 *
 * For AAPL, NVDA, SPY and BTC-USD it calls getQuote, getHistoricalCandles (1m..1d) and
 * searchSymbols through the PRODUCTION provider, and records per call: HTTP status, latency,
 * rate-limit headers, normalised fields, timestamp semantics, bar alignment, session mix,
 * incomplete/future candles, and field drift versus the committed fixtures. Sanitised raw
 * responses are written next to the report for review before being committed as fixtures.
 * The API key is never printed or written.
 *
 * `--dry-run-mock` exercises the script against the mock provider (no HTTP, no validation).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pino } from 'pino';
import { LOG_REDACT_PATHS, findRepoFile, loadConfig } from '@signals/config';
import {
  auditCandles,
  createMarketDataProvider,
  fieldDiff,
  MarketDataError,
  sanitizeForFixture,
  type VendorResponseObservation,
} from '@signals/market-data';
import { TIMEFRAMES, type Timeframe } from '@signals/types';

const SYMBOLS: { symbol: string; kind: 'us-equity' | 'crypto' }[] = [
  { symbol: 'AAPL', kind: 'us-equity' },
  { symbol: 'NVDA', kind: 'us-equity' },
  { symbol: 'SPY', kind: 'us-equity' },
  { symbol: 'BTC-USD', kind: 'crypto' },
];
const LIMIT = 300;

async function main() {
  const config = loadConfig();
  const dryRun = process.argv.includes('--dry-run-mock');
  if (config.MARKET_DATA_PROVIDER !== 'real' && !dryRun) {
    console.error(
      'Refusing to run: MARKET_DATA_PROVIDER must be "real" (this validates the live vendor).',
    );
    process.exit(2);
  }
  const secrets = [config.MARKET_DATA_API_KEY ?? ''].filter(Boolean);
  const observations: VendorResponseObservation[] = [];
  const provider = createMarketDataProvider({
    provider: dryRun ? 'mock' : 'real',
    vendor: config.MARKET_DATA_VENDOR,
    apiKey: config.MARKET_DATA_API_KEY,
    baseUrl: config.MARKET_DATA_BASE_URL,
    allowCustomBaseUrl: config.MARKET_DATA_ALLOW_CUSTOM_BASE_URL,
    delayed: config.MARKET_DATA_DELAYED,
    timeoutMs: config.MARKET_DATA_TIMEOUT_MS,
    maxRetries: config.MARKET_DATA_MAX_RETRIES,
    requestsPerMinute: config.MARKET_DATA_RATE_LIMIT_PER_MINUTE,
    sessionMode: config.MARKET_SESSION_MODE,
    logger: pino({ level: 'warn', redact: LOG_REDACT_PATHS }),
    onResponse: (o) => observations.push(o),
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(
    findRepoFile('pnpm-workspace.yaml', process.cwd())!,
    '..',
    'validation-output',
    'market-data',
    stamp,
  );
  mkdirSync(join(outDir, 'sanitized-responses'), { recursive: true });
  const fixturesDir = resolve(outDir, '../../../packages/market-data/test/fixtures/twelvedata');
  const recorded = (name: string) => {
    try {
      return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };

  const results: Record<string, unknown>[] = [];
  const run = async (
    label: string,
    symbol: string | null,
    fn: () => Promise<Record<string, unknown>>,
  ) => {
    const before = observations.length;
    const started = Date.now();
    let result: Record<string, unknown>;
    try {
      result = { ok: true, ...(await fn()) };
    } catch (e) {
      result = {
        ok: false,
        errorCode: e instanceof MarketDataError ? e.code : 'UNKNOWN',
        error: String((e as Error).message ?? e),
      };
    }
    const obs = observations.slice(before);
    const last = obs.at(-1);
    const row: Record<string, unknown> & { httpStatuses: (number | null)[]; latencyMs: number } = {
      call: label,
      symbol,
      ...result,
      latencyMs: Date.now() - started,
      attempts: obs.length,
      httpStatuses: obs.map((o) => o.httpStatus),
      rateLimitHeaders: last?.rateLimitHeaders ?? {},
    };
    if (last?.body !== undefined) {
      const file = `${label.replace(/[^a-z0-9]+/gi, '_')}.json`;
      writeFileSync(
        join(outDir, 'sanitized-responses', file),
        JSON.stringify(sanitizeForFixture(last.body, { maxValues: 60, secrets }), null, 2),
      );
      (row as Record<string, unknown>).rawResponseFile = `sanitized-responses/${file}`;
    }
    results.push(row);
    console.info(
      `${row.ok ? '✔' : '✘'} ${label} ${row.ok ? '' : `[${String(row.errorCode)}] `}status=${row.httpStatuses.join(',') || '-'} ${row.latencyMs}ms`,
    );
    return last?.body;
  };

  const now = () => Date.now();
  for (const { symbol, kind } of SYMBOLS) {
    const quoteBody = await run(`quote ${symbol}`, symbol, async () => {
      const q = await provider.getQuote(symbol);
      return {
        normalized: q,
        timestampAgeSeconds: Math.round((now() - Date.parse(q.timestamp)) / 1000),
      };
    });
    if (quoteBody && symbol === 'NVDA') {
      (results.at(-1) as Record<string, unknown>).fieldDriftVsFixture = fieldDiff(
        quoteBody,
        recorded('quote.json'),
      );
    }
    for (const tf of TIMEFRAMES) {
      const body = await run(`candles ${symbol} ${tf}`, symbol, async () => {
        const candles = await provider.getHistoricalCandles(symbol, tf as Timeframe, LIMIT);
        return {
          returned: candles.length,
          firstNormalized: candles[0],
          lastNormalized: candles.at(-1),
          audit: auditCandles(candles, tf as Timeframe, now(), {
            graceMs: config.CANDLE_CLOSE_GRACE_MS,
            assetKind: kind,
          }),
        };
      });
      if (body && tf === '5m' && symbol === 'NVDA') {
        const liveItem = (body as { values?: unknown[] }).values?.[0];
        const recordedItem = (
          recorded('time_series_5min.json') as { values?: unknown[] } | undefined
        )?.values?.[0];
        const r = results.at(-1) as Record<string, unknown>;
        r.fieldDriftVsFixture = {
          top: fieldDiff(body, recorded('time_series_5min.json')),
          value: fieldDiff(liveItem, recordedItem),
        };
      }
    }
  }
  await run('search AAPL', null, async () => ({
    results: await provider.searchSymbols('AAPL', 10),
  }));
  await run('search BTC', null, async () => ({ results: await provider.searchSymbols('BTC', 10) }));

  const report = {
    generatedAt: new Date().toISOString(),
    provider: provider.name,
    dryRun,
    sessionMode: config.MARKET_SESSION_MODE,
    candleCloseGraceMs: config.CANDLE_CLOSE_GRACE_MS,
    results,
  };
  const serialized = JSON.stringify(report, null, 2);
  for (const s of secrets) {
    if (serialized.includes(s))
      throw new Error('refusing to write report: API key found in output');
  }
  writeFileSync(join(outDir, 'report.json'), serialized);
  writeFileSync(join(outDir, 'report.md'), toMarkdown(report));
  const failed = results.filter((r) => !r.ok).length;
  console.info(`\nReport: ${outDir}/report.md  (${results.length} calls, ${failed} failed)`);
  process.exitCode = failed ? 1 : 0;
}

function toMarkdown(report: {
  generatedAt: string;
  provider: string;
  dryRun: boolean;
  results: Record<string, unknown>[];
}): string {
  const lines = [
    `# Market data validation - ${report.provider}${report.dryRun ? ' (DRY RUN - mock, not a validation)' : ''}`,
    '',
    `Generated ${report.generatedAt}`,
    '',
    '| Call | OK | HTTP | ms | Candles | Newest | Incomplete | Future | Grid offsets (min) | Timestamps | Sessions | Credits |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of report.results) {
    const a = r.audit as
      | {
          count: number;
          newest: { timestamp: string } | null;
          incompleteCount: number;
          futureCount: number;
          gridOffsetsMinutes: number[];
          timestampSemantics: { verdict: string };
          sessions?: Record<string, number>;
        }
      | undefined;
    const credits = Object.entries((r.rateLimitHeaders as Record<string, string>) ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    lines.push(
      `| ${String(r.call)} | ${r.ok ? '✔' : `✘ ${String(r.errorCode)}`} | ${(r.httpStatuses as unknown[]).join(',')} | ${String(r.latencyMs)} | ${a?.count ?? ''} | ${a?.newest?.timestamp ?? ''} | ${a?.incompleteCount ?? ''} | ${a?.futureCount ?? ''} | ${a?.gridOffsetsMinutes?.join(',') ?? ''} | ${a?.timestampSemantics.verdict ?? ''} | ${a?.sessions ? JSON.stringify(a.sessions) : ''} | ${credits} |`,
    );
  }
  return lines.join('\n') + '\n';
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
