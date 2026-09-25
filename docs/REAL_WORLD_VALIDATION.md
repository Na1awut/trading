# Real-world validation (Phase 3)

> **Beta status: BLOCKED.** Live market data, Firebase Authentication, FCM delivery and the
> tap-to-open deep link on a physical Android device have **not** been validated against the
> real services. The tooling to validate each of them is in the repository and is described
> below. See the [release gate](#12-release-gate).

This document separates what was **validated for real**, what was **validated in
simulation** (and exactly what was simulated), and what was **not validated**. Nothing is
counted as validated because it passed with mocks.

## Environment of this run (2026-09-25)

| Resource                           | Available | Notes                                                                                                      |
| ---------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| PostgreSQL 16                      | Yes       | Local instance; real SQL, real constraints, real `pg_total_relation_size`                                  |
| Built API and worker (`dist/`)     | Yes       | Validations run the production bundles as separate OS processes                                            |
| Twelve Data (`api.twelvedata.com`) | **No**    | Egress is blocked by the environment's proxy (HTTP 403 with an HTML body) and no API key is configured     |
| Firebase project / service account | **No**    | No credentials in the environment                                                                          |
| Physical Android device            | **No**    | Cloud container                                                                                            |
| Headless Chromium                  | Yes       | Used for the React Native **Web** build of the app (network conditions only; not a substitute for Android) |

To unblock the first two in a cloud session, allow `api.twelvedata.com` (and
`identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, `fcm.googleapis.com`,
`oauth2.googleapis.com`) in the environment's network settings and add
`MARKET_DATA_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_BASE64` and
`FIREBASE_WEB_API_KEY` as environment secrets. Never paste them into chat or commit them.

## Summary

| #   | Area                           | Result                                                                                                         | Evidence                               |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1   | Baseline                       | **Validated**: tests, lint, typecheck and build green                                                          | [§1](#1-baseline)                      |
| 2   | Live Twelve Data               | **Not validated**: egress blocked, no key. Tooling ready.                                                      | [§2](#2-market-data)                   |
| 3   | Worker soak on live data       | **Not validated** on live data. Concurrency/restart/idempotency validated on real processes with mock candles. | [§3](#3-worker-soak-and-idempotency)   |
| 4   | Firebase Auth (real project)   | **Not validated**: no project. Script ready.                                                                   | [§4](#4-firebase-authentication)       |
| 5   | Android push (physical device) | **Not validated**: no device, no FCM credentials. Payload audited on real engine output.                       | [§5](#5-push-notifications)            |
| 6   | App network conditions         | **Validated in simulation** (web build, intercepted API); 3 bugs found and fixed                               | [§6](#6-app-network-conditions)        |
| 7   | Security                       | **Validated** on built binaries + Postgres: 56/56 checks; 1 bug fixed                                          | [§7](#7-security)                      |
| 8   | Load 100/500/1000 users        | **Validated in simulation** (real cycle + Postgres; mock candles; simulated push latency); 1 scaling bug fixed | [§8](#8-load-simulation)               |
| 9   | DB growth and retention        | **Validated** (real Postgres sizes; retention run); growth risk documented                                     | [§9](#9-database-growth-and-retention) |
| 10  | Operational metrics            | **Implemented and tested**                                                                                     | [§10](#10-operational-metrics)         |

## Integration problems found and fixed

| #   | Found by                                  | Problem                                                                                                                                                                     | Fix                                                                                                                                                            |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Real HTTP to the vendor host (proxy 403)  | A non-JSON error page (HTML 401/403/404/5xx from a proxy, CDN or gateway) was classified `BAD_RESPONSE`, hiding the real cause                                              | Non-JSON responses with status ≥ 400 are classified by status (`FORBIDDEN`, `UNAUTHORIZED`, …); only a non-JSON 2xx is `BAD_RESPONSE`. Regression tests added. |
| F2  | Built API against the failing vendor path | Every `MarketDataError` reached clients as a generic **500 Internal Server Error**                                                                                          | **503** (transient; `Retry-After` on rate limits) or **502** (key/plan/response problems) with `code: MARKET_DATA_UNAVAILABLE`; vendor details only in logs    |
| F3  | Load simulation                           | Fan-out recorded and pushed one subscriber at a time: ~45 ms per subscriber, **~51 s for one signal with 1,000 subscribers** (the last user notified ~50 s after the first) | One multi-row `INSERT … ON CONFLICT DO NOTHING` per 500 subscribers, and delivery with bounded concurrency (`NOTIFICATION_DELIVERY_CONCURRENCY`, default 8)    |
| F4  | Network simulation (timeout)              | The app had **no request timeout**; a hung server left the skeleton spinning forever                                                                                        | 15 s timeout with "The server did not respond in time"                                                                                                         |
| F5  | Network simulation (refresh failure)      | A failed background refresh **replaced** the watchlist with a full-screen error, discarding prices                                                                          | Data stays visible with a "Couldn't refresh · showing data from HH:MM" banner (watchlist, asset detail, history)                                               |
| F6  | Network simulation (offline after load)   | Going offline after a good load kept showing old prices **with no indication** (React Query pauses fetching when offline)                                                   | "Offline · showing data from HH:MM" banner; also "Not updated since HH:MM" after 3 missed polls; native apps refetch as soon as they return to the foreground  |
| F7  | Review during F4–F6                       | Quote times were shown as `HH:MM` only, so Friday's close looked like today's price on Monday morning                                                                       | Date shown when the quote is not from today                                                                                                                    |

## Known production risks (not fixed)

| Risk                                                                                                                                                                                                                                                                         | Why it is not fixed now                                                                                                   | Recommendation                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing about the live vendor (field formats, timestamps, 1h bar alignment, session coverage of the plan, latency, credit use) has been observed                                                                                                                             | Egress blocked, no key                                                                                                    | Run `validate:market-data` first; it is the top release blocker                                                                                                                                                                           |
| **SignalEvent storage grows with users × triggers.** Each subscriber gets a full copy of the evidence (~1.3 KB of a ~1.8 KB row; ~3.8 KB on disk with indexes/TOAST). With the mock trigger rate, 1,000 users on AAPL/NVDA/SPY at 5m would add ~50k rows (~5.5 GB) per month | A schema change (storing each occurrence once) touches the API and app; not justified before real trigger rates are known | Measure the real trigger rate during the live soak. If it is near the mock rate, store occurrences once and reference them per user, and decide an event retention policy (history is user-facing, and needed for any future backtesting) |
| One SQL-heavy delivery path: ~11 statements per delivered event                                                                                                                                                                                                              | Fine at 1,000 users (see §8); not the bottleneck                                                                          | Revisit past ~10k subscribers per signal                                                                                                                                                                                                  |
| iOS push (APNs token → FCM) is not implemented                                                                                                                                                                                                                               | Out of scope (Android beta)                                                                                               | See NOTIFICATIONS.md                                                                                                                                                                                                                      |
| Market-data licensing for redistribution is unconfirmed                                                                                                                                                                                                                      | Commercial, not technical                                                                                                 | Confirm with the vendor before any external user sees data                                                                                                                                                                                |

---

## 1. Baseline

At the start of Phase 3 (commit `d9abd1a`, CI run #2 green): 256 tests passed (1 file
skipped: live fixtures, which only run when recorded), lint, typecheck (9 projects) and
build green. At the end of Phase 3: **263 tests passed** (same skipped file), lint, typecheck,
format check and build green.

## 2. Market data

**Status: not validated.** Requests to `api.twelvedata.com` from this environment are refused
by the egress proxy (HTTP 403, HTML body), and there is no key. This did expose F1.

What is ready (`pnpm --filter @signals/worker validate:market-data`, refuses to run unless
`MARKET_DATA_PROVIDER=real`):

- AAPL, NVDA, SPY (US equities) and BTC/USD (crypto): quote plus 1m, 5m, 15m, 1h, 1d (300
  bars each), and symbol search.
- Per request: HTTP status, latency, attempts, error code, rate-limit/credit headers.
- Per series (`auditCandles`): count, first/last timestamps, ordering, modal spacing, gaps,
  grid offset in minutes (detects 1h bars at :30), future bars, incomplete newest bar,
  session of every bar in America/New_York (regular / extended / overnight / weekend), local
  time of each day's first bar, and a verdict on timestamp semantics (UTC, exchange-local
  mislabelled as UTC, or date-only for daily).
- Drift report: fields present live but missing from our fixtures and vice versa.
- Sanitized responses (keys, account/plan/request IDs and anything secret-looking removed;
  newest 60 values) written to `validation-output/…/sanitized-responses/`. Copy reviewed
  ones into `packages/market-data/test/fixtures/twelvedata/live/`; the `live-fixtures` test
  suite then checks their invariants in CI.
- The run aborts if the API key appears anywhere in its output.

Checked against documentation only (not observed): `prepost` is plan-dependent and limited
to 1–30 min intervals, so `MARKET_SESSION_MODE=extended` only applies there. The `timezone`
parameter does not apply to daily bars, which are dates. Whether 1h bars start at :30 during
regular hours is unknown. If they do, the audit shows `gridOffsetsMinutes: [30]`: signals
stay correct but the incremental fetch refetches more than needed.

## 3. Worker soak and idempotency

**Live-data soak: not validated** (no market data). Triggers during a live soak must come
from the market; nothing in the code or scripts forces one.

**Validated on real processes (market data = deterministic mock provider)** with
`validate:idempotency`: two built worker processes, unsharded (the misconfiguration worst
case: both evaluate every pair), against Postgres for 6 minutes on 8 symbols × 5 users at
1m. Worker A is `SIGKILL`ed at 45% and restarted 15 s later.

| Check                                                          | Before F3 fix | After F3 fix |
| -------------------------------------------------------------- | ------------- | ------------ |
| Events produced by normal evaluation                           | 75            | 45           |
| Duplicate `SignalEvent` rows                                   | 0             | 0            |
| Duplicate inserts detected and skipped by the competing worker | 50            | 30           |
| Events on incomplete candles                                   | 0             | 0            |
| Events left `PENDING`/`SENDING`                                | 0             | 0            |
| Events pushed more than once                                   | 0             | 0            |
| Repeat run over the same state creates events                  | 0             | 0            |
| Two shards (0/2, 1/2) partition the pairs without overlap      | 2 + 6 = 8     | 2 + 6 = 8    |

## 4. Firebase Authentication

**Status: not validated** (no Firebase project). `pnpm --filter @signals/api
validate:firebase --api <url>` runs against a real project and a running API
(`AUTH_MODE=firebase`, `AUTH_REQUIRE_EMAIL_VERIFIED=true`, `AUTH_CHECK_REVOKED=true`). It
creates a throwaway user through the same Identity Toolkit endpoints the app's SDK uses and
checks: sign-up, verification email requested, unverified user rejected (403), verified
user accepted after token refresh, password sign-in accepted, tampered signature and
modified claims rejected (401), revoked session rejected and its refresh token dead, and
(with `--wait-expiry`) an expired ID token rejected. It then deletes the user and never
prints tokens or keys. Google sign-in needs a device and is in the protocol below.

What was validated without Firebase (§7): in production mode the built API boots with a
well-formed service account, rejects a forged ID token and a dev token (401), and fails fast
without echoing an unparseable service account.

## 5. Push notifications

**Status: not validated on a device or against FCM.**

Validated: `validate:push --audit-only` builds the exact FCM messages (same builder as the
worker) for 25 events produced by the real evaluation engine and checks each:

- `data` has exactly `eventId, signalType, symbol, timeframe, type, url`, all strings;
- no key matches email/user/uid/token/key/secret/password/evidence/firebase, and no value
  contains the user ID or email;
- `url` is `stocksignals://signals/events/<id>` (the app's `scheme` and route);
- Android `channelId` is `signals` (created by the app) and `tag` is the event ID, so
  at-least-once redelivery replaces rather than duplicates;
- the payload is under FCM's 4 KB limit (300–338 bytes).

Result: **75/75 checks passed.** A sample message, with the token redacted:

```json
{
  "notification": {
    "title": "AAPL — EMA Bullish Cross",
    "body": "EMA 9 crossed above EMA 21 at $238.97 (1m)"
  },
  "data": {
    "type": "signal",
    "eventId": "cmuhh5clk000w7dxo6t2yvpy5",
    "symbol": "AAPL",
    "signalType": "EMA_BULLISH_CROSS",
    "timeframe": "1m",
    "url": "stocksignals://signals/events/cmuhh5clk000w7dxo6t2yvpy5"
  },
  "android": {
    "priority": "high",
    "notification": { "channelId": "signals", "tag": "cmuhh5clk000w7dxo6t2yvpy5" }
  },
  "apns": {
    "headers": { "apns-collapse-id": "cmuhh5clk000w7dxo6t2yvpy5" },
    "payload": { "aps": { "sound": "default" } }
  }
}
```

The events were produced by the real engine from **mock** candles. The audit shows what FCM
would receive; it does not show what a phone displays.

Ready for credentials: `validate:push --email <user>` validates each registered device token
with an FCM dry run, sends the user's latest real event through the production sender, and
checks that a malformed token is classified permanently invalid. It does not create events.

### Android device protocol (manual, required for beta)

Use a **development or production build** (`npx expo run:android` or EAS) with
`google-services.json`, on a physical phone. Expo Go and emulators are not valid. Record
the result of each step.

1. Fresh install → sign up with email → verify email → sign in. `GET /me` succeeds in API logs.
2. Grant notification permission. `POST /devices/register` → 201; a `Device` row exists with
   `provider = FCM`.
3. Settings → Send test notification: arrives with the app **foregrounded**, **backgrounded**
   and **force-closed**.
4. With the worker on live data, wait for a real signal on a watched ticker (use 1m during
   market hours to shorten the wait). Confirm the notification text matches the event in
   History.
5. Tap it with the app backgrounded, and again with it force-closed: the "Signal explained"
   screen opens for **that** event ID.
6. Sign in on a second device with the same account; both receive the next signal.
7. Uninstall on one device; after the next signal, its `Device` row is deleted
   (`registration-token-not-registered`) and the event is still `SENT` for the other device.
8. Airplane mode during a signal: the event is `FAILED` with a retry scheduled, then `SENT`
   after connectivity returns (FCM holds and delivers).
9. Sign out: the device token is unregistered; no further pushes arrive.
10. Token refresh: clear app data or reinstall; the new token registers and the old row is
    removed on the next failed send.
11. Google sign-in (if enabled) on the device.
12. Network: airplane mode after loading the watchlist shows "Couldn't refresh · showing data
    from HH:MM" within ~30 s; restoring the network clears it; backgrounding the app for more
    than a minute and returning refreshes immediately.

## 6. App network conditions

**Validated in simulation.** `pnpm --filter @signals/mobile validate:network` drives the
React Native **Web** build in headless Chromium and intercepts every API call. It exercises
the app's own state logic (React Query, the API client and the screens); Android networking
and OS behaviour are not exercised (protocol step 12 covers them).

| Scenario                                                 | Before fixes                           | After fixes                 |
| -------------------------------------------------------- | -------------------------------------- | --------------------------- |
| Normal: prices, no warning badges                        | PASS                                   | PASS                        |
| Slow (3 s): skeleton, then data                          | PASS                                   | PASS                        |
| API 500 on first load: error + Retry, no prices          | PASS                                   | PASS                        |
| Offline on first load: "Cannot reach the server"         | PASS                                   | PASS                        |
| Server never answers                                     | **FAIL** (endless skeleton)            | PASS (error after 15 s)     |
| Refresh fails after a good load                          | **FAIL** (prices replaced by an error) | PASS (prices kept, flagged) |
| Connection lost after a good load                        | **FAIL** (old prices shown as current) | PASS (flagged "Offline")    |
| Stale quote → "Stale"                                    | PASS                                   | PASS                        |
| Market closed → "Market closed"                          | PASS                                   | PASS                        |
| Delayed plan → "Delayed"                                 | PASS                                   | PASS                        |
| Vendor failure for one symbol: row explains, others load | PASS                                   | PASS                        |

## 7. Security

**Validated** with `validate:security`: the built binaries as OS processes, a real Postgres
database, and per-run fake secrets (a real-shaped vendor key, a service account with a
freshly generated RSA key, a bearer token, a dev email and a device token). **56/56 checks
pass.**

- **Production guards.** Both the API and the worker refuse to start with `AUTH_MODE=dev`,
  `CORS_ORIGINS=*`, `MARKET_DATA_PROVIDER=mock`, `TRUST_PROXY=true`, a real provider without
  a key, or Firebase auth without a project ID.
- **Auth.** The production API rejects a forged Firebase token and a dev token (401), and
  fails fast on an unparseable service account without echoing it.
- **Secrets.** None of the secrets appears in any log line (API at `info`, worker at
  `debug`, including the vendor failure path and the FCM initialisation path) or in any
  response body.
- **Malformed input.** 32 cases, including path traversal, SQL-ish and unicode symbols, NUL
  bytes, unknown or injected timeframes, out-of-range limits, non-JSON bodies, the wrong
  content type, array bodies, a `__proto__` payload, a 200 KB body (413), bad device tokens
  (short, spaces/quotes, 5,000 chars, wrong type), bad platform/provider, unknown signal
  types, absurd parameters, bad timezones and quiet hours, over-long IDs (414 from Fastify's
  parameter limit) and bad auth headers. All get 4xx; **zero 5xx**; no stack traces in
  bodies.
- F2 was found here.

## 8. Load simulation

`validate:load` runs the **real** evaluation cycle and delivery code against Postgres, with
N users each watching AAPL, NVDA and SPY on 5m with the default preset signals (7 per
ticker), for 24 cycles (2 simulated hours, one candle per cycle). **Simulated:** candles
come from the mock provider (no vendor latency) and each push costs 40 ms (an assumed FCM
round trip). Triggers come from normal evaluation; the same 8 occurred at every size.

| Users | Subscriptions | Candle requests per cycle | SQL per quiet cycle | Quiet cycle p50 | Events | Worst cycle, before F3 | Worst cycle, after F3 | ms per event, before → after |
| ----- | ------------- | ------------------------- | ------------------- | --------------- | ------ | ---------------------- | --------------------- | ---------------------------- |
| 100   | 2,100         | 3                         | 30                  | 26 ms           | 800    | 5.3 s                  | 0.9 s                 | 44.6 → 7.1                   |
| 500   | 10,500        | 3                         | 30                  | 29 ms           | 4,000  | 26.3 s                 | 4.0 s                 | 44.6 → 6.7                   |
| 1,000 | 21,000        | 3                         | 30                  | 37 ms           | 8,000  | 54.2 s                 | 7.9 s                 | 44.6 → 6.5                   |

- **Market-data requests do not grow with users:** 3 per closed candle (one per pair) at
  every size. Candles are fetched once per pair and shared by all subscribers and signals.
- **Evaluation** is cheap and flat (~30 SQL statements, ~30 ms per quiet cycle); the cost
  is entirely in fan-out and delivery, which scale linearly with subscribers per signal
  (~11 SQL statements per delivered event).
- **Notification queue:** 0 events pending after every cycle at every size, before and
  after the fix.

## 9. Database growth and retention

`validate:db-growth` creates rows through the normal code paths (users, devices and preset
subscriptions via the db services; SignalEvents via 3 simulated hours of the real evaluation
cycle; MarketCandles via `saveCandles`), then measures real on-disk size after `VACUUM
ANALYZE`.

| Table              | Bytes per row on disk (heap + indexes + TOAST) | Grows with                                        |
| ------------------ | ---------------------------------------------- | ------------------------------------------------- |
| MarketCandle       | 136                                            | Tickers × timeframes × bars; bounded by retention |
| SignalEvent        | ~3,800 (1.8 KB row; evidence JSON ~1.3 KB)     | Subscribers × triggers; **no retention**          |
| SignalSubscription | ~300                                           | Users × watched tickers × 7 presets               |
| Device             | small (1–2 per user)                           | Users                                             |

Projections (equities 5 trading days/week; candles from the retention policy; events from
the **mock** trigger rate of 3.06% per signal evaluation, which is an assumption):

| Scenario                                 | MarketCandle / day   | MarketCandle steady state (excl. 1d) | SignalEvent / day (5m) | SignalEvent / month (5m) | SignalEvent / month (all 1m) |
| ---------------------------------------- | -------------------- | ------------------------------------ | ---------------------- | ------------------------ | ---------------------------- |
| 1,000 users, AAPL/NVDA/SPY, 5 timeframes | 1,506 rows (0.2 MB)  | 4.8 MB                               | ~50k                   | ~5.5 GB                  | ~27 GB                       |
| 10,000 users, 200 equities + 10 crypto   | 118,890 rows (15 MB) | 399 MB                               | ~500k                  | ~55 GB                   | ~270 GB                      |

**Retention (validated):** with 10 days of 1m candles and a 7-day policy, retention deleted
the 4,321 oldest rows in 17 ms, kept everything newer than the cutoff (more than the
250-candle lookback), left daily bars untouched (policy 0 = forever), and a second run
deleted nothing. **Retention was not changed.** The defaults keep 1m for 7 days, 5m for 60,
15m for 180, 1h for 730 and 1d forever. Shortening them would limit any future backtesting to
what the vendor can re-supply within the plan's history limits. SignalEvent, Device and
SignalSubscription have no automatic retention; see the risks table.

## 10. Operational metrics

Implemented (see [PRODUCTION.md](PRODUCTION.md#monitoring)): worker cycles, failures and
duration; market-data requests, failures by code and latency; cache hits/misses; candle-store
hits/misses; pairs evaluated/skipped; signals triggered; events created and duplicates
absorbed; notifications sent, retried and failed, and the pending gauge. Exposed on the
worker's internal health port and on the API behind `METRICS_TOKEN`, as JSON or Prometheus.

## 12. Release gate

(Step 11 of the plan is this document.)

Beta requires every **critical** item to be ✅. Any ❌ means **BLOCKED**.

| Critical | Item                                                                                                                              | Status                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Yes      | Automated tests, lint, typecheck and build green                                                                                  | ✅                                                    |
| Yes      | Production config guards refuse unsafe settings (built binaries)                                                                  | ✅                                                    |
| Yes      | No secrets in logs or responses; malformed input rejected without 5xx                                                             | ✅                                                    |
| Yes      | No duplicate events with concurrent/restarted workers; completed candles only                                                     | ✅ (mock candles)                                     |
| Yes      | **Live quotes and candles for AAPL, NVDA, SPY, BTC/USD: fields, timestamps, sessions, latency, credits** (`validate:market-data`) | ❌ not run                                            |
| Yes      | **Candle completion verified on live bars** (no incomplete or future bar evaluated)                                               | ❌ not run                                            |
| Yes      | **Live worker soak** through at least one full US session with natural triggers                                                   | ❌ not run                                            |
| Yes      | **Firebase Auth on a real project** (`validate:firebase`)                                                                         | ❌ not run                                            |
| Yes      | **FCM delivery to a physical Android device** in foreground, background and closed states                                         | ❌ not run                                            |
| Yes      | **Tapping a push opens `/signals/events/:id`** for that event, from background and cold start                                     | ❌ not run                                            |
| Yes      | Push payload has identifiers only, under 4 KB                                                                                     | ✅ (audit on engine output; not observed on a device) |
| Yes      | Market-data licence permits showing data and alerts to users                                                                      | ❌ unconfirmed                                        |
| No       | App distinguishes loading / error / stale / delayed / market closed; never shows old data as current                              | ✅ (web build) · device step 12 pending               |
| No       | Load at 1,000 users within one candle; queue drains                                                                               | ✅ (simulated push latency)                           |
| No       | DB growth understood; retention verified                                                                                          | ✅ · SignalEvent growth is an open risk               |
| No       | Operational metrics available                                                                                                     | ✅                                                    |
| No       | Google sign-in on a device                                                                                                        | ❌ not run                                            |

**Verdict: BLOCKED** on the seven ❌ critical items.

## Commands

```bash
pnpm install && pnpm db:up && pnpm db:deploy
pnpm test && pnpm lint && pnpm typecheck && pnpm build

# Validation databases (once)
for db in signals_validation signals_load signals_growth; do
  createdb -h localhost -U signals "$db"
  DATABASE_URL="postgresql://signals:signals@localhost:5432/$db" pnpm --filter @signals/db exec prisma migrate deploy
done

# Runs here (no external credentials needed)
pnpm --filter @signals/worker validate:security
pnpm --filter @signals/worker validate:idempotency --minutes 6
pnpm --filter @signals/worker validate:load --users 100,500,1000 --cycles 24
pnpm --filter @signals/worker validate:db-growth
pnpm --filter @signals/worker validate:push --audit-only
EXPO_PUBLIC_API_URL=http://127.0.0.1:4555 pnpm --filter @signals/mobile export:web
pnpm --filter @signals/mobile validate:network

# Need credentials / hardware (not run)
MARKET_DATA_PROVIDER=real MARKET_DATA_VENDOR=twelvedata MARKET_DATA_API_KEY=… \
  pnpm --filter @signals/worker validate:market-data
pnpm --filter @signals/api validate:firebase --api https://your-api [--wait-expiry]
pnpm --filter @signals/worker validate:push --email you@example.com
```

Reports are written to `validation-output/<kind>/<timestamp>/` (git-ignored).
