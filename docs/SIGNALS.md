# Signal reference

All signals are evaluated on **completed candles** and fire once when their condition
**changes from false to true** (see [ARCHITECTURE.md](ARCHITECTURE.md#firing-once-transition-tracking)).
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

## Explainability

Each event stores:

- `message`, for example "EMA 9 crossed above EMA 21 at $182.30" or "RSI 14 crossed upward through 30 (now 31.2)"
- `values`, the rule's own values (`ema9`, `ema21`, `macd`, …) plus standard context:
  `close`, `rsi14`, `volume`, `avgVolume20`, `volumeRatio`
- `price`, `timeframe`, `candleTime` (open time of the completed candle), and `triggeredAt`

## Adding a signal type

1. Add the type to `SIGNAL_TYPES` in `packages/types/src/signals.ts` and to the `SignalType`
   enum in `schema.prisma`, then run `pnpm db:migrate --name add_signal_x`.
2. Implement a `SignalRule` in `packages/signal-engine/src/rules/*`: a parameter schema, a
   level `condition(i)`, `values(i)`, and `message()`. Register it in `SIGNAL_RULES`.
3. Add tests. The catalog, API validation, and app then pick it up automatically.
