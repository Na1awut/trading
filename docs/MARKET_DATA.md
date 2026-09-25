# Market data providers

```ts
interface MarketDataProvider {
  readonly name: string;
  readonly delayed: boolean; // surfaced in the UI next to prices
  readonly supportedTimeframes: Timeframe[];
  searchAssets(query, limit?): Promise<AssetInfo[]>;
  getAsset(symbol): Promise<AssetInfo | null>;
  getQuote(symbol): Promise<Quote>;
  getHistoricalCandles(symbol, timeframe, limit): Promise<Candle[]>; // ascending; last may be in progress
}
```

| Implementation               | Use                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MockMarketDataProvider`     | Default. Deterministic synthetic data (a pure function of symbol and time), so the API and worker agree without sharing state. It produces regular crossovers and volume spikes. There are 15 sample assets, including ETFs, crypto (`BTC-USD`), and Thai equities (`PTT.BK`). It ignores exchange sessions and holidays. |
| `ScriptedMarketDataProvider` | Tests and `pnpm demo:slice`: explicit candle series                                                                                                                                                                                                                                                                       |
| `CachedMarketDataProvider`   | A TTL cache decorator used by the API to protect vendor rate limits                                                                                                                                                                                                                                                       |
| `RealMarketDataProvider`     | **Placeholder.** It throws until a vendor is implemented                                                                                                                                                                                                                                                                  |

## Adding a real vendor

1. Implement the four methods in `packages/market-data/src/real-provider.ts` (or add a new
   class per vendor and select it in `createMarketDataProvider`).
2. Map vendor symbols to canonical symbols (for example SET listings use `.BK`).
3. Configure the environment (never commit keys):
   ```
   MARKET_DATA_PROVIDER=real
   MARKET_DATA_VENDOR=<vendor>
   MARKET_DATA_API_KEY=<secret>
   MARKET_DATA_BASE_URL=<https://...>
   ```
4. Set `delayed` truthfully; the app shows "Delayed" next to prices.

## Things to verify with any vendor

**No provider is assumed to be free or suitable for production.** Before choosing one of
Polygon, Finnhub, Alpha Vantage, Twelve Data, Tiingo, or another vendor, check the current
terms on the vendor's own pricing and licensing pages:

- **Licensing and redistribution.** Many low-cost or free plans are for personal, non-display
  use only. Sending derived alerts or prices to end users can require a commercial
  or "display" licence and exchange agreements (for example real-time US equities need
  exchange fees and entitlements; the SET has its own vendor licensing).
- **Real-time vs delayed.** Free tiers are commonly delayed by 15 minutes or end-of-day only. Alerts on
  delayed data are delayed alerts, so say so in the UI (the `delayed` flag).
- **Rate limits.** The worker makes roughly `active (ticker, timeframe) pairs × (60 000 / SIGNAL_POLL_INTERVAL_MS)`
  candle requests per minute. The API adds quote and candle requests, cached for 10 s. Use
  `SIGNAL_FETCH_CONCURRENCY` and longer poll intervals to stay within limits; at scale, prefer
  a streaming or WebSocket feed.
- **History depth.** EMA 50 and MACD need at least 60 completed candles; the default lookback is 250.
- **Corporate actions.** Split and dividend adjustments change historical candles. Stored
  transition state prevents re-firing on revised candles, but indicators will shift.
- **Candle alignment.** The engine assumes UTC-aligned candle open times (`candleOpenTime`).
  Daily candles for non-US venues may need exchange-timezone alignment.
