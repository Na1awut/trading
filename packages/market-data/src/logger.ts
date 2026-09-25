/** Minimal structured logger (pino-compatible). Never pass secrets in `obj`. */
export interface MarketDataLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const noopLogger: MarketDataLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
