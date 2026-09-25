import { createServer, type Server } from 'node:http';
import type { Metrics } from '@signals/config';

/** Liveness state shared between the scheduler and the optional health endpoint. */
export class WorkerHealth {
  lastCycleAt: number | null = null;
  lastSuccessAt: number | null = null;
  consecutiveFailures = 0;
  private readonly startedAt: number;

  constructor(
    private readonly maxSilenceMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  recordSuccess() {
    this.lastCycleAt = this.lastSuccessAt = this.now();
    this.consecutiveFailures = 0;
  }

  recordFailure() {
    this.lastCycleAt = this.now();
    this.consecutiveFailures++;
  }

  /** Healthy while a cycle has succeeded within maxSilenceMs (grace period after start). */
  snapshot() {
    const reference = this.lastSuccessAt ?? this.startedAt;
    const healthy = this.now() - reference <= this.maxSilenceMs;
    return {
      status: healthy ? 'ok' : 'unhealthy',
      lastCycleAt: this.lastCycleAt ? new Date(this.lastCycleAt).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

/**
 * Internal (not internet-facing) port: GET /health for liveness probes and GET /metrics
 * (JSON, or Prometheus text with ?format=prometheus).
 */
export function startHealthServer(health: WorkerHealth, port: number, metrics?: Metrics): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/metrics' && metrics) {
      if (url.searchParams.get('format') === 'prometheus') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(metrics.prometheus());
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(metrics.snapshot()));
      }
      return;
    }
    if (req.method !== 'GET' || url.pathname !== '/health') {
      res.writeHead(404).end();
      return;
    }
    const snap = health.snapshot();
    res.writeHead(snap.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(snap));
  });
  server.listen(port);
  return server;
}
