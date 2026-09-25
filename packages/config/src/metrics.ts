/**
 * Minimal in-process metrics: counters, gauges and timing summaries (count / sum / max).
 * Exposed as JSON or Prometheus text by the worker health port and the API /metrics route.
 * Deliberately tiny - swap for OpenTelemetry/prom-client only if you outgrow it.
 */
export type Labels = Record<string, string | number | boolean>;

interface Timing {
  count: number;
  sum: number;
  max: number;
}

function key(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const body = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`)
    .join(',');
  return `${name}{${body}}`;
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly timings = new Map<string, Timing>();

  inc(name: string, labels?: Labels, by = 1): void {
    if (by === 0) return;
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  set(name: string, value: number, labels?: Labels): void {
    this.gauges.set(key(name, labels), value);
  }

  observe(name: string, value: number, labels?: Labels): void {
    const k = key(name, labels);
    const t = this.timings.get(k) ?? { count: 0, sum: 0, max: 0 };
    t.count++;
    t.sum += value;
    t.max = Math.max(t.max, value);
    this.timings.set(k, t);
  }

  counter(name: string, labels?: Labels): number {
    return this.counters.get(key(name, labels)) ?? 0;
  }

  /** Sum of a counter across all label combinations. */
  total(name: string): number {
    let n = 0;
    for (const [k, v] of this.counters) if (k === name || k.startsWith(`${name}{`)) n += v;
    return n;
  }

  snapshot() {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      timings: Object.fromEntries(
        [...this.timings].map(([k, t]) => [
          k,
          { ...t, avg: t.count ? Math.round((t.sum / t.count) * 10) / 10 : 0 },
        ]),
      ),
    };
  }

  prometheus(prefix = 'signals_'): string {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`${prefix}${k} ${v}`);
    for (const [k, v] of this.gauges) lines.push(`${prefix}${k} ${v}`);
    for (const [k, t] of this.timings) {
      const [name, labels = ''] = k.split(/(?=\{)/);
      lines.push(
        `${prefix}${name}_count${labels} ${t.count}`,
        `${prefix}${name}_sum${labels} ${t.sum}`,
        `${prefix}${name}_max${labels} ${t.max}`,
      );
    }
    return lines.sort().join('\n') + '\n';
  }
}
