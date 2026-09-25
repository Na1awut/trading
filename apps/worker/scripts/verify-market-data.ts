/**
 * Smoke test for the configured market-data provider (run once with real credentials
 * before going live):
 *
 *   MARKET_DATA_PROVIDER=real MARKET_DATA_VENDOR=twelvedata MARKET_DATA_API_KEY=... \
 *     pnpm --filter @signals/worker verify:market-data NVDA
 *
 * Checks quote, candles for every timeframe (strictly completed + freshness), and search.
 * Uses ~7 vendor requests. Never prints the API key.
 */
import { pino } from 'pino';
import { LOG_REDACT_PATHS, loadConfig } from '@signals/config';
import {
  assessCandleFreshness,
  assessQuoteFreshness,
  createMarketDataProvider,
  MarketDataError,
} from '@signals/market-data';
import { completedCandles } from '@signals/signal-engine';
import { TIMEFRAMES } from '@signals/types';

async function main() {
  const config = loadConfig();
  const symbol = (process.argv[2] ?? 'NVDA').toUpperCase();
  const logger = pino({ level: 'warn', redact: LOG_REDACT_PATHS });
  const provider = createMarketDataProvider({
    provider: config.MARKET_DATA_PROVIDER,
    vendor: config.MARKET_DATA_VENDOR,
    apiKey: config.MARKET_DATA_API_KEY,
    baseUrl: config.MARKET_DATA_BASE_URL,
    allowCustomBaseUrl: config.MARKET_DATA_ALLOW_CUSTOM_BASE_URL,
    delayed: config.MARKET_DATA_DELAYED,
    timeoutMs: config.MARKET_DATA_TIMEOUT_MS,
    maxRetries: config.MARKET_DATA_MAX_RETRIES,
    requestsPerMinute: config.MARKET_DATA_RATE_LIMIT_PER_MINUTE,
    sessionMode: config.MARKET_SESSION_MODE,
    logger,
  });
  const now = Date.now();
  let failures = 0;
  const check = async (label: string, fn: () => Promise<string>) => {
    try {
      console.info(`✔ ${label}: ${await fn()}`);
    } catch (e) {
      failures++;
      const code = e instanceof MarketDataError ? ` [${e.code}]` : '';
      console.error(`✘ ${label}${code}: ${(e as Error).message}`);
    }
  };

  console.info(`Provider: ${provider.name} (delayed=${provider.delayed}) symbol=${symbol}\n`);
  await check('quote', async () => {
    const q = await provider.getQuote(symbol);
    const f = assessQuoteFreshness(q, now, config.MARKET_DATA_STALE_QUOTE_MS);
    return `${q.price} ${q.currency} (${q.changePercent.toFixed(2)}%) at ${q.timestamp} exchange=${q.exchange} marketOpen=${q.marketOpen} stale=${f.stale}`;
  });
  for (const tf of TIMEFRAMES) {
    await check(`candles ${tf}`, async () => {
      const raw = await provider.getHistoricalCandles(symbol, tf, 60);
      const done = completedCandles(raw, tf, now, config.CANDLE_CLOSE_GRACE_MS);
      const f = assessCandleFreshness(done, tf, now, { graceMs: config.CANDLE_CLOSE_GRACE_MS });
      const last = done.at(-1);
      return `${raw.length} returned, ${done.length} completed, last ${last?.timestamp ?? 'none'} close=${last?.close ?? '-'}, missing=${f.missingCandles}`;
    });
  }
  await check('search', async () => {
    const results = await provider.searchSymbols(symbol.replace(/\..*$/, ''), 5);
    return (
      results.map((r) => `${r.symbol} (${r.assetClass}, ${r.exchange})`).join(', ') || 'no results'
    );
  });
  console.info(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
