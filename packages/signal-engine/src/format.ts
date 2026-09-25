const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', THB: '฿', EUR: '€', GBP: '£', JPY: '¥' };

export function formatPrice(value: number, currency = 'USD'): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? '';
  const decimals = Math.abs(value) < 1 ? 4 : 2;
  const text = value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return symbol ? `${symbol}${text}` : `${text} ${currency}`;
}

export function formatNumber(value: number, decimals = 2): string {
  return value.toFixed(decimals);
}

/** 61_200_000 -> "61.2M" */
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
}
