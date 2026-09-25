const CURRENCY: Record<string, string> = { USD: '$', THB: '฿', EUR: '€', GBP: '£', JPY: '¥' };

export function formatPrice(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const decimals = Math.abs(value) < 1 ? 4 : 2;
  const n = value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const sym = CURRENCY[currency];
  return sym ? `${sym}${n}` : `${n} ${currency}`;
}

/**
 * Signed price change: "+$1.06", "−$0.96". Precision follows the PRICE (sub-$1 assets
 * need 4 decimals), not the size of the change.
 */
export function formatChange(change: number, price: number, currency = 'USD'): string {
  if (!Number.isFinite(change)) return '—';
  const decimals = Math.abs(price) < 1 ? 4 : 2;
  const abs = Math.abs(change).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const sym = CURRENCY[currency];
  const body = sym ? `${sym}${abs}` : `${abs} ${currency}`;
  return `${change < 0 ? '−' : '+'}${body}`;
}

export function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Local time with seconds, e.g. "09:42:00". */
export function formatTimeSeconds(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? formatTime(iso)
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${formatTime(iso)}`;
}

/** Human labels for indicator keys stored in SignalEvent.values. */
export function valueLabel(key: string): string {
  const known: Record<string, string> = {
    close: 'Close',
    volume: 'Volume',
    volumeRatio: 'Volume vs average',
    volumeZScore: 'Volume z-score',
    macd: 'MACD',
    macdSignal: 'MACD signal line',
    macdHistogram: 'MACD histogram',
    pctChange: 'Change',
    threshold: 'Threshold',
    level: 'Level',
    multiplier: 'Multiplier',
  };
  if (known[key]) return known[key];
  const m = /^(ema|rsi|avgVolume)(\d+)$/.exec(key);
  if (m) {
    const name = m[1] === 'ema' ? 'EMA' : m[1] === 'rsi' ? 'RSI' : 'Avg volume';
    return `${name} ${m[1] === 'avgVolume' ? `(${m[2]})` : m[2]}`;
  }
  return key;
}

export function formatValue(
  key: string,
  value: number | null | undefined,
  currency = 'USD',
): string {
  if (value === null || value === undefined) return '—';
  if (key === 'volume' || key.startsWith('avgVolume')) return formatCompact(value);
  if (key === 'volumeRatio' || key === 'multiplier') return `${formatNumber(value, 2)}x`;
  if (key === 'pctChange') return formatPct(value);
  if (key === 'close' || key.startsWith('ema')) return formatPrice(value, currency);
  if (key.startsWith('rsi') || key === 'level') return formatNumber(value, 1);
  if (key.startsWith('macd')) return formatNumber(value, 3);
  return formatNumber(value, 2);
}
