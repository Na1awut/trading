# Stock Signal Alerts (MVP)

A mobile app and backend for watchlist-based **technical signal alerts**. Add tickers,
see the latest price and indicators, and get a push notification that explains exactly
why a signal fired, e.g. _"EMA 9 crossed above EMA 21 at $182.30"_.

> **Informational and educational use only.** Signals are generated automatically from
> technical indicators. They are not investment advice, personalised recommendations, or
> instructions to buy or sell. The app never shows a bare "BUY"/"SELL".

Everything runs locally **without paid services**: mock market data, Postgres in Docker,
console-logged notifications and a dev login.

```
apps/
  api/            Fastify REST API + OpenAPI (Swagger UI at /docs)
  worker/         Background signal evaluator (separate process)
  mobile/         Expo / React Native app (expo-router)
packages/
  types/          Shared domain types + zod schemas (used by API and app)
  signal-engine/  Indicators (EMA, RSI, MACD, volume) + signal rules. Pure, tested.
  market-data/    MarketDataProvider interface, mock + placeholder real provider
  config/         Validated environment configuration
  db/             Prisma schema, migrations, domain services, seed
  notifications/  NotificationSender interface: console (dev), FCM, test recorder
docs/             Architecture, signals, market data, notifications
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## Prerequisites

- Node.js **22+** and **pnpm 10** (`corepack enable`)
- Docker (for Postgres), or any local PostgreSQL 14+
- For the mobile app: Expo tooling; a phone with a **development build** for real push notifications

## Quick start

```bash
pnpm install                 # also generates the Prisma client
cp .env.example .env         # works as-is for local development
pnpm db:up                   # Postgres 16 in Docker (creates `signals` and `signals_test`)
pnpm db:deploy               # apply migrations
pnpm db:seed                 # demo user demo@example.com with NVDA, AAPL, SPY
pnpm dev                     # API on :4000 + worker (Ctrl+C to stop)
```

Then:

- API docs: <http://localhost:4000/docs>
- Try it: `curl -H "Authorization: Bearer dev:demo@example.com" localhost:4000/watchlist`
- Mobile: `cp apps/mobile/.env.example apps/mobile/.env`, then `pnpm dev:mobile` (see [Mobile app](#mobile-app))

### The first vertical slice in one command

```bash
pnpm demo:slice
```

This runs the complete flow against your local database:

1. `demo@example.com` adds **NVDA** to the watchlist (auto-subscribes to preset signals).
2. The market data has an **EMA 9 / EMA 21 bullish crossover on the last completed candle**.
3. The worker evaluates the signal (completed candles only).
4. A `SignalEvent` is saved with the explanation and indicator values.
5. The notification service fires (console driver, which logs `🔔 [push:console] NVDA — EMA Bullish Cross …`).
6. A second poll on the same candle creates **no duplicate**.

Sign in to the app as `demo@example.com` (dev login) and open **History** to see the event.

## Commands

| Command                              | What it does                                                               |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `pnpm dev`                           | API (watch mode) + worker together                                         |
| `pnpm dev:api` / `dev:worker`        | Run one of them                                                            |
| `pnpm dev:mobile`                    | Expo dev server                                                            |
| `pnpm test`                          | All tests (unit + API + worker integration; needs Postgres)                |
| `pnpm test:unit`                     | Unit tests only: engine, market data, config, notifications (no DB needed) |
| `pnpm lint`                          | ESLint (TypeScript strict rules)                                           |
| `pnpm typecheck`                     | `tsc --noEmit` in every package, including the mobile app                  |
| `pnpm format` / `format:check`       | Prettier                                                                   |
| `pnpm build`                         | Bundle API and worker to `dist/` (tsup)                                    |
| `pnpm db:migrate`                    | Create and apply a new migration after editing `schema.prisma` (dev)       |
| `pnpm db:deploy`                     | Apply pending migrations (CI and production)                               |
| `pnpm db:seed` / `db:studio`         | Seed demo data / open Prisma Studio                                        |
| `pnpm --filter @signals/worker once` | Run a single evaluation cycle and exit                                     |

## Database and migrations

- The schema lives in `packages/db/prisma/schema.prisma`; migrations are in `packages/db/prisma/migrations`.
- After changing the schema: `pnpm db:migrate --name describe_change` (creates **and** applies the migration, then regenerates the client). Commit the generated SQL.
- Deploy: `pnpm db:deploy` (never `migrate dev` against shared databases).
- Reset local dev data: `pnpm --filter @signals/db migrate:reset`.
- Prisma scripts read the repo-root `.env`. Real environment variables take precedence.

## Tests

`pnpm test` runs 99 tests:

- **signal-engine** (47): EMA/RSI/MACD checked against published reference tables and
  independently cross-checked against the `technicalindicators` library. Also covers EMA 9/21
  crossover detection (including the "fires once, not again while above" case), RSI
  threshold crossings in all four directions, MACD crossovers, volume spikes (1.5x, 2x,
  z-score), price and % triggers, and parameter validation.
- **API** (21, Fastify `inject` against Postgres): auth, validation, watchlist, assets,
  signals, history pagination, per-user isolation, devices, settings, rate limiting, OpenAPI.
- **worker** (13, Postgres): the full vertical slice, and duplicate prevention three ways
  (same candle polled again, lost state blocked by the DB unique constraint, and three
  concurrent workers producing exactly one event and one notification). Also suppression
  rules, NO_DEVICES, invalid-token cleanup, and failure isolation.
- **market-data, config, notifications** (18): the mock provider's determinism and timeframe
  consistency, caching, env validation guards, and notification formatting.

Integration tests use `TEST_DATABASE_URL` (default `postgresql://signals:signals@localhost:5432/signals_test`).
Each suite gets its own schema (`api_test`, `worker_test`); migrations are applied automatically.
They never touch `DATABASE_URL`.

## Mobile app

```bash
cp apps/mobile/.env.example apps/mobile/.env
pnpm dev:mobile        # press i / a, or scan the QR code
```

- **API URL:** set `EXPO_PUBLIC_API_URL`. The Android emulator uses `http://10.0.2.2:4000`; a physical
  device uses your machine's LAN IP.
- **Login:** without Firebase config the app uses **dev login**: any email, no password, and
  the API must run with `AUTH_MODE=dev`. Use `demo@example.com` to see seeded data.
- **Push notifications** need a physical device with a
  [development build](https://docs.expo.dev/develop/development-builds/introduction/)
  (`npx expo run:android` / `run:ios`). Expo Go and simulators cannot receive remote push;
  everything else works there. See [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md).
- Screens: Login, Watchlist, Search, Asset detail, Signal configuration, Signal history,
  Signal explained (event detail), and Settings.

## Configuration

All configuration is environment variables, validated at startup by `packages/config`
(the process refuses to start with a clear message if something is wrong).
[`.env.example`](.env.example) documents every variable. Highlights:

| Variable                   | Default   | Notes                                                                                |
| -------------------------- | --------- | ------------------------------------------------------------------------------------ |
| `AUTH_MODE`                | `dev`     | `firebase` in production. `dev` is **rejected** when `NODE_ENV=production`           |
| `NOTIFICATION_DRIVER`      | `console` | `fcm` to send real pushes                                                            |
| `MARKET_DATA_PROVIDER`     | `mock`    | `real` needs a vendor implementation and `MARKET_DATA_API_KEY`                       |
| `SIGNAL_POLL_INTERVAL_MS`  | `30000`   | Worker cycle interval (`.env.example` uses 15000)                                    |
| `SIGNAL_DEFAULT_TIMEFRAME` | `5m`      | Timeframe for preset signals (`.env.example` uses `1m` so dev alerts appear quickly) |

### Where credentials go later

| Credential                        | Variable(s)                                                                                                                              | Where to get it                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Firebase Admin (API auth, FCM)    | `FIREBASE_PROJECT_ID` + `FIREBASE_SERVICE_ACCOUNT_PATH` **or** `FIREBASE_SERVICE_ACCOUNT_BASE64` **or** `GOOGLE_APPLICATION_CREDENTIALS` | Firebase console → Project settings → Service accounts      |
| Firebase web config (mobile auth) | `EXPO_PUBLIC_FIREBASE_*` in `apps/mobile/.env`                                                                                           | Firebase console → Project settings → Your apps             |
| FCM native config (mobile builds) | `apps/mobile/google-services.json`, `GoogleService-Info.plist`                                                                           | Firebase console (these files are git-ignored)              |
| Market data vendor                | `MARKET_DATA_VENDOR`, `MARKET_DATA_API_KEY`, `MARKET_DATA_BASE_URL`                                                                      | Your vendor; see [docs/MARKET_DATA.md](docs/MARKET_DATA.md) |

Never commit `.env` files, service accounts or API keys (`.gitignore` covers the usual file names).

## Security notes

- Every route except `/health` and `/docs` requires a bearer token (a Firebase ID token, or `dev:<email>` in dev mode).
- Every request body, query and param is validated with zod; responses are serialised through schemas, so unknown fields are stripped.
- Rate limiting is global (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`) and stricter on `/devices/test`. Helmet headers, CORS allow-list, and a 64 KB body limit are on.
- Data is scoped per user in every query; tests assert cross-user isolation.
- Production config guards: dev auth and wildcard CORS are refused.

## Status and next steps

The MVP scope is implemented end to end. Not yet done:

- Google sign-in (needs OAuth client IDs; Firebase Auth supports it once configured)
- iOS FCM tokens (needs `@react-native-firebase/messaging`; see docs/NOTIFICATIONS.md)
- Quiet hours, digest frequency and minimum signal strength are stored and returned but not yet enforced
- A retry sweep for events left `PENDING` by a crash between insert and send
- A real market-data vendor implementation
