import type { VendorResponseObservation } from './http/vendor-http-client';

/** Structural metrics sink (implemented by @signals/config Metrics). */
export interface MetricsSink {
  inc(name: string, labels?: Record<string, string | number | boolean>, by?: number): void;
  observe(name: string, value: number, labels?: Record<string, string | number | boolean>): void;
}

/** Map one vendor HTTP attempt to request / failure / latency metrics. */
export function recordMarketDataObservation(m: MetricsSink, o: VendorResponseObservation): void {
  m.inc('market_data_requests_total', { vendor: o.vendor, operation: o.operation, ok: o.ok });
  if (!o.ok)
    m.inc('market_data_request_failures_total', {
      vendor: o.vendor,
      code: o.errorCode ?? 'UNKNOWN',
    });
  m.observe('market_data_request_duration_ms', o.durationMs, {
    vendor: o.vendor,
    operation: o.operation,
  });
}
