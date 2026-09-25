# Live Twelve Data regression fixtures

Empty until a live validation run is performed (see docs/REAL_WORLD_VALIDATION.md).

To add fixtures:

1. Run `pnpm --filter @signals/worker validate:market-data` with real credentials.
2. Review the files in `validation-output/market-data/<run>/sanitized-responses/`. They are
   already stripped of API keys and account or request identifiers. Check them again anyway.
3. Copy the ones worth keeping here as `<endpoint>__<symbol>__<interval>.json`, for example
   `time_series__NVDA__5min.json`, `quote__AAPL.json` or `symbol_search__AAPL.json`.

`test/live-fixtures.test.ts` normalises every file through the adapter and checks the
invariants: UTC ISO timestamps, ascending order, consistent OHLC values, and finite numbers.
