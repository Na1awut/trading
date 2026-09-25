# Signal reference

All signals are evaluated on **completed candles** (closed for at least
`CANDLE_CLOSE_GRACE_MS`) and fire once when their condition **changes from false to true**
(see [ARCHITECTURE.md](ARCHITECTURE.md#firing-once)).
Parameters are validated by the zod schema of each rule in `packages/signal-engine/src/rules`.

| Type                    | Category | Condition (level)                     | Fires when                         | Default parameters                             |
| ----------------------- | -------- | ------------------------------------- | ---------------------------------- | ---------------------------------------------- |
| `PRICE_ABOVE`           | Price    | close > threshold                     | a close crosses above X            | `threshold` (required)                         |
| `PRICE_BELOW`           | Price    | close < threshold                     | a close crosses below X            | `threshold` (required)                         |
| `PCT_MOVE_UP`           | Price    | % change over `lookback` ≥ threshold  | a rise of at least X%              | `threshold: 3, lookback: 1`                    |
| `PCT_MOVE_DOWN`         | Price    | % change over `lookback` ≤ −threshold | a drop of at least X%              | `threshold: 3, lookback: 1`                    |
| `EMA_BULLISH_CROSS`     | Trend    | EMA fast > EMA slow                   | fast crosses above slow            | `fast: 9, slow: 21` (preset also 20/50)        |
| `EMA_BEARISH_CROSS`     | Trend    | EMA fast < EMA slow                   | fast crosses below slow            | `fast: 9, slow: 21` (preset also 20/50)        |
| `PRICE_CROSS_ABOVE_EMA` | Trend    | close > EMA(period)                   | price crosses above EMA 20         | `period: 20`                                   |
| `PRICE_CROSS_BELOW_EMA` | Trend    | close < EMA(period)                   | price crosses below EMA 20         | `period: 20`                                   |
| `RSI_OVERBOUGHT`        | Momentum | RSI > 70                              | RSI enters overbought              | `period: 14, level: 70`                        |
| `RSI_OVERSOLD`          | Momentum | RSI < 30                              | RSI enters oversold                | `period: 14, level: 30`                        |
| `RSI_CROSS_UP`          | Momentum | RSI > 30                              | RSI crosses upward through 30      | `period: 14, level: 30`                        |
| `RSI_CROSS_DOWN`        | Momentum | RSI < 70                              | RSI crosses downward through 70    | `period: 14, level: 70`                        |
| `MACD_BULLISH_CROSS`    | Momentum | MACD > signal                         | MACD crosses above its signal line | `fast: 12, slow: 26, signal: 9`                |
| `MACD_BEARISH_CROSS`    | Momentum | MACD < signal                         | MACD crosses below its signal line | `fast: 12, slow: 26, signal: 9`                |
| `VOLUME_SPIKE`          | Volume   | volume > multiplier × avg(prev 20)    | volume jumps above 1.5x or 2x      | `multiplier: 1.5, period: 20` (preset also 2x) |
| `VOLUME_ANOMALY`        | Volume   | (volume − avg) / stdev ≥ k            | an abnormal spike (z-score)        | `period: 20, stdDevs: 3`                       |

## Indicator definitions

- **EMA**: k = 2 / (n + 1), seeded with the SMA of the first n values (TA-Lib and TradingView convention).
- **RSI**: Wilder's smoothing. The first averages are simple means of 14 changes; afterwards
  `avg = (prev × 13 + current) / 14`. RSI is 50 when there is no movement at all.
- **MACD**: EMA12 − EMA26; signal = EMA9 of the MACD line; histogram = MACD − signal.
- **Average volume (20)**: the mean of the **previous** 20 candles, excluding the current one, so a spike does
  not inflate its own baseline. The anomaly rule uses the population standard deviation of the same window.

Verification: `packages/signal-engine/test/indicators.test.ts` checks these against published
reference tables and cross-checks them against the independent `technicalindicators` library
on 300 to 400 candle random walks.

## Explainability: structured evidence

Every `SignalEvent` stores structured **evidence** (`SignalEvidence` v1, schema in
`packages/types/src/signals.ts`), not just a sentence:

```json
{
  "version": 1,
  "type": "EMA_BULLISH_CROSS",
  "symbol": "NVDA",
  "timeframe": "5m",
  "parameters": { "fast": 9, "slow": 21 },
  "condition": { "previous": false, "current": true },
  "previous": { "close": 181.9, "ema9": 181.42, "ema21": 181.55 },
  "current":  { "close": 182.3, "ema9": 181.91, "ema21": 181.73 },
  "candle": { "timestamp": "2026-09-25T13:40:00.000Z", "open": 181.9, "high": 182.4, "low": 181.8, "close": 182.3, "volume": 410000 },
  "previousCandle": { "timestamp": "2026-09-25T13:35:00.000Z", "…": "…" },
  "context": { "rsi14": 63.2, "volume": 410000, "avgVolume20": 256000, "volumeRatio": 1.6 },
  "strength": { "score": 3, "maxScore": 5, "level": "HIGH", "direction": "up", "components": [ … ] }
}
```

- `previous` and `current` hold the rule's own values on both candles, which is the
  false → true transition that caused the event.
- The app's **Signal explained** screen renders these values directly (previous candle,
  current candle, price, timeframe, trigger time). The server's `message` is kept for push
  notification text and for older clients.
- Events recorded before Phase 2 have `evidence: null`; the app falls back to `values`.

## Signal strength

**Strength is technical-condition agreement, not expected return, probability, or
investment quality.** It is never displayed as "strong buy" or "strong sell". The app words
it as, for example, "HIGH · 3 of 5 conditions agree".

The score is 1 (for the trigger) plus the number of enabled confirmations that agree with
the signal's **direction**, evaluated on the trigger candle:

| Confirmation | Agrees when (direction up / down)                      | Skipped for    |
| ------------ | ------------------------------------------------------ | -------------- |
| `volume`     | volume ≥ 1.5× the 20-period average (either direction) | volume signals |
| `rsi`        | RSI 14 > 50 / < 50                                     | RSI signals    |
| `trend`      | close > EMA 50 / < EMA 50                              | –              |
| `macd`       | MACD histogram > 0 / < 0                               | MACD signals   |

- **Levels:** 1 point → `LOW`, 2 → `MEDIUM`, 3+ → `HIGH` (thresholds are configurable in
  `StrengthModel`).
- **Direction** describes the movement a condition represents. For example, "RSI rose above
  70" is `up` and a bearish EMA cross is `down`. It is not a judgement. Volume signals have no
  direction, so they score 1/1 (LOW).
- **Configuration:** `SIGNAL_STRENGTH_CONFIRMATIONS=volume,rsi,trend,macd` (any subset).
- **Storage:** `SignalEvent.signalScore`, `maxSignalScore`, `signalStrength`, plus the
  component breakdown in `evidence.strength`.
- **User setting:** `minimumSignalStrength` (LOW / MEDIUM / HIGH). Notifications below it are
  suppressed, but the events still appear in history.

## Adding a signal type

1. Add the type to `SIGNAL_TYPES` in `packages/types/src/signals.ts` and to the `SignalType`
   enum in `schema.prisma`, then run `pnpm db:migrate --name add_signal_x`.
2. Implement a `SignalRule` in `packages/signal-engine/src/rules/*`: a parameter schema, a
   level `condition(i)`, `values(i)`, and `message()`. Register it in `SIGNAL_RULES`.
3. Add tests. The catalog, API validation, and app then pick it up automatically.
