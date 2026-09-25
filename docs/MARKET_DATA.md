# Market data

## Provider contract

```ts
interface MarketDataProvider {
  readonly name: string; // "twelvedata", "mock", …
  readonly delayed: boolean; // shown next to prices
  readonly supportedTimeframes: Timeframe[];
  searchSymbols(query, limit?): Promise<AssetInfo[]>;
  getAsset(symbol): Promise<AssetInfo | null>;
  getQuote(symbol): Promise<Quote>;
  getHistoricalCandles(symbol, timeframe, limit): Promise<NormalizedCandle[]>; // ascending; last may be in progress
}
```

Every provider returns **normalised domain models**. Vendor response formats, field names
and error formats never leave `packages/market-data`.

```ts
Quote { symbol, price, change, changePercent, previousClose, volume,
        timestamp /* ISO 8601 UTC */, currency, exchange, marketOpen, delayed, source }
NormalizedCandle { symbol, timeframe, time /* epoch ms UTC */, timestamp /* ISO UTC */,
                   open, high, low, close, volume }
```

All times are UTC internally. The app converts them to the device's timezone for display.

| Implementation               | Use                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `RealMarketDataProvider`     | Production. Generic reliability transport plus a vendor adapter (Twelve Data).                                     |
| `CachedMarketDataProvider`   | A decorator over any provider, backed by a `MarketDataCache`                                                       |
| `MockMarketDataProvider`     | Local development. Deterministic synthetic data, 24/7. Refused in production unless `ALLOW_MOCK_MARKET_DATA=true`. |
| `ScriptedMarketDataProvider` | Tests and `pnpm demo:slice`                                                                                        |

## Vendor choice: Twelve Data

Evaluated in September 2026 for the MVP's needs. Check these points against the vendors'
current documentation and pricing before you sign up.

| Need                           | Twelve Data                                                               | Finnhub                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Quote                          | `/quote`                                                                  | `/quote`                                                                                                                   |
| Historical OHLCV candles       | `/time_series`; 1min, 5min, 15min, 1h and 1day in one endpoint            | `/stock/candle` moved to paid plans; free keys get 403 ([issue #546](https://github.com/finnhubio/Finnhub-API/issues/546)) |
| All of 1m / 5m / 15m / 1h / 1d | Yes                                                                       | Only on paid plans (candles)                                                                                               |
| Symbol search                  | `/symbol_search`                                                          | `/search`                                                                                                                  |
| Other asset classes            | Equities, ETFs, indices, forex, crypto; many exchanges, including the SET | Mixed                                                                                                                      |
| Limits                         | Credit-based per minute and per day, depending on plan                    | 60 calls/min (free)                                                                                                        |

**Decision:** Twelve Data. One vendor covers quotes, candles for every timeframe, and symbol
search. With Finnhub's candles behind a paywall, the signal engine would have needed a second
vendor.

> **Not verified against the live API.** The development environment could not reach
> `api.twelvedata.com` (egress is blocked), so the adapter was built from the documented
> response format and tested against fixtures in `packages/market-data/test/fixtures`.
> Before production, run the smoke test in [PRODUCTION.md](PRODUCTION.md#verify-market-data).

## Configuration

```
MARKET_DATA_PROVIDER=real
MARKET_DATA_VENDOR=twelvedata
MARKET_DATA_API_KEY=<secret>                  # never commit; use a secret manager
MARKET_DATA_BASE_URL=                         # optional; default https://api.twelvedata.com
MARKET_DATA_ALLOW_CUSTOM_BASE_URL=false       # true only for an operator-controlled egress proxy
MARKET_DATA_DELAYED=true                      # match your plan; the UI shows "Delayed"
MARKET_DATA_TIMEOUT_MS=8000
MARKET_DATA_MAX_RETRIES=3
MARKET_DATA_RATE_LIMIT_PER_MINUTE=8           # per process; match your plan
MARKET_DATA_QUOTE_TTL_MS=10000
MARKET_DATA_STALE_QUOTE_MS=1800000
CANDLE_CLOSE_GRACE_MS=5000
```

These variables are vendor-neutral. Adding a vendor means adding a `VendorAdapter` and
registering it in `packages/market-data/src/vendors/index.ts`.

## Twelve Data adapter details (`src/vendors/twelvedata.ts`)

- **Authentication.** The `apikey` query parameter (the documented method). The key is removed
  from every log line and error message; tests assert this.
- **Candles.** `/time_series?interval=…&outputsize=N&timezone=UTC&order=asc`. Intraday
  datetimes are UTC. Daily bars are exchange-local **dates**, which we store as that date at
  00:00 UTC. The adapter sorts results ascending, de-duplicates them, and checks OHLC
  consistency (`low ≤ open, close ≤ high`).
- **Errors.** Twelve Data can return an error with **HTTP 200** and a body of
  `{status: "error", code, message}`, so the adapter classifies the body code, not just the
  HTTP status.
- **Symbol mapping.**

  | Canonical | Vendor request            |
  | --------- | ------------------------- |
  | `NVDA`    | `symbol=NVDA`             |
  | `PTT.BK`  | `symbol=PTT&exchange=SET` |
  | `BTC-USD` | `symbol=BTC/USD`          |

  Search results outside US venues and the SET are dropped. Other venues would collide with
  US tickers until they get an explicit mapping.

- **Response validation.** zod schemas for every endpoint. Malformed responses become
  `BAD_RESPONSE` and are not retried.

## Reliability

| Condition                                          | Code                   | Retried?                   |
| -------------------------------------------------- | ---------------------- | -------------------------- |
| 401                                                | `UNAUTHORIZED`         | No                         |
| 403 (feature not on the plan)                      | `FORBIDDEN`            | No                         |
| Unknown or invalid symbol (400/404)                | `INVALID_SYMBOL`       | No                         |
| Other 4xx                                          | `BAD_REQUEST`          | No                         |
| Malformed body                                     | `BAD_RESPONSE`         | No                         |
| 429, or the local rate limiter would wait too long | `RATE_LIMITED`         | Yes; honours `Retry-After` |
| 5xx (500, 502, 503, 504)                           | `UPSTREAM_UNAVAILABLE` | Yes                        |
| Timeout (`MARKET_DATA_TIMEOUT_MS`)                 | `TIMEOUT`              | Yes                        |
| Connection or DNS error                            | `NETWORK`              | Yes                        |

Retries are **bounded**: at most `MARKET_DATA_MAX_RETRIES` after the first attempt. They use
exponential backoff with equal jitter (base 500 ms, capped at 10 s). A client-side token
bucket queues requests so the process stays within `MARKET_DATA_RATE_LIMIT_PER_MINUTE`.
Each attempt logs the vendor, operation, symbol, path, HTTP status, attempt number, duration
and error code; it never logs the query string or key.

The API degrades gracefully. A symbol whose quote fails shows `quoteError` in the watchlist
while the other symbols still load.

## Caching

- `MarketDataCache` is an async, JSON-value interface, so Redis can drop in (a sketch is in
  `src/cache.ts`). `InMemoryMarketDataCache` is an LRU cache with TTLs, used by default.
- **Quotes:** `MARKET_DATA_QUOTE_TTL_MS` (default 10 s).
- **Candles:** kept until the **next candle of that timeframe closes** (plus the grace period),
  capped at 15 minutes. Completed history cannot change before then, so every user viewing
  NVDA 5m shares one download per 5 minutes.
- **Search:** 60 s. **Asset metadata:** 6 h.
- Concurrent identical cache misses share one in-flight request. Failures are never cached.

Across processes, the worker stores completed candles in `MarketCandle`, and the API reads
that store before calling the vendor. As a result each `(ticker, timeframe)` series is
downloaded once and reused by every user and every API instance. The worker fetches only the
missing tail each time a candle closes, and makes no vendor call at all while no new candle
is due.

## Freshness (stale data)

- **Quote:** stale when older than `MARKET_DATA_STALE_QUOTE_MS` **and** the market is open
  or its state is unknown. A closed market legitimately shows the last close.
- **Candles:** stale when more than 2 fully closed candles are missing after the latest
  stored one, and the market is not known to be closed.
- The API returns `dataStatus` for each watchlist item and for the asset detail (quote and
  candles). The app shows **Stale**, **Market closed** or **Delayed** badges.

## Licensing, limits and delays

**No provider is assumed to be free or suitable for production.** Check these on the
vendor's own pricing and terms pages:

- **Redistribution.** Pushing alerts or prices to end users can require a commercial or
  "display" licence and exchange agreements. This applies to real-time US equities and to SET
  data, among others.
- **Delayed data.** Many plans delay some exchanges by 15 minutes or more. Alerts on delayed
  data are delayed alerts, so set `MARKET_DATA_DELAYED` truthfully.
- **Credits.** The worker makes about one candle request per active `(ticker, timeframe)` per
  closed candle. The API adds quote and search requests, which are cached. Each process has
  its own budget (`MARKET_DATA_RATE_LIMIT_PER_MINUTE`), so split your plan's quota between
  the API and worker instances.
- **History depth.** EMA 50 and MACD need at least 60 candles; the default lookback is 250.
- **Corporate actions.** Split and dividend adjustments rewrite history. Stored transition
  state stops old signals from re-firing, but indicators will shift.
