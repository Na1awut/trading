import { randomUUID } from 'node:crypto';
import type { PrismaClient, SignalDefinition, SignalState } from '@signals/db';
import type { MarketDataProvider } from '@signals/market-data';
import type { Logger, NotificationSender } from '@signals/notifications';
import {
  DEFAULT_STRENGTH_MODEL,
  createSignalContext,
  evaluateSignal,
  parseSignalParameters,
  type SignalEvaluation,
  type StrengthModel,
} from '@signals/signal-engine';
import type { Metrics } from '@signals/config';
import { latestClosedCandleOpenTime, type Timeframe } from '@signals/types';
import { loadCandleWindow } from './candle-source';
import { mapWithConcurrency } from './concurrency';
import { fanOutSignal } from './notifications/events';
import type { DeliverySettings } from './notifications/settings';
import { PairFetchTracker } from './pair-tracker';

export interface WorkerSettings {
  candleLookback: number;
  fetchConcurrency: number;
  candleCloseGraceMs: number;
  maxCatchupCandles: number;
  incompleteRefetchMs: number;
  /** Horizontal scaling without a queue: this instance handles pairs where hash % count == index. */
  shardIndex: number;
  shardCount: number;
  strengthModel: StrengthModel;
}

export const DEFAULT_WORKER_SETTINGS: WorkerSettings = {
  candleLookback: 250,
  fetchConcurrency: 4,
  candleCloseGraceMs: 0,
  maxCatchupCandles: 3,
  incompleteRefetchMs: 60_000,
  shardIndex: 0,
  shardCount: 1,
  strengthModel: DEFAULT_STRENGTH_MODEL,
};

export interface CycleDeps {
  prisma: PrismaClient;
  marketData: MarketDataProvider;
  notifier: NotificationSender;
  logger: WorkerLogger;
  now?: () => number;
  settings?: Partial<WorkerSettings>;
  /** Cross-cycle memory (fetch back-off). Create once per process with createWorkerRuntime(). */
  runtime?: WorkerRuntime;
  /** Persist/read candles via MarketCandle (default true). */
  ingest?: boolean;
  delivery?: Partial<DeliverySettings>;
  /** Optional metrics sink (see @signals/config Metrics). */
  metrics?: Metrics;
  /** Back-compat aliases (Phase 1 options). */
  candleLookback?: number;
  fetchConcurrency?: number;
}

/** pino-compatible; `debug`/`child` are optional so simple test loggers work. */
export type WorkerLogger = Logger & {
  debug?: (obj: object, msg?: string) => void;
  child?: (bindings: object) => WorkerLogger;
};

export interface WorkerRuntime {
  pairTracker: PairFetchTracker;
}

export function createWorkerRuntime(settings: Partial<WorkerSettings> = {}): WorkerRuntime {
  return {
    pairTracker: new PairFetchTracker(
      settings.incompleteRefetchMs ?? DEFAULT_WORKER_SETTINGS.incompleteRefetchMs,
    ),
  };
}

export interface CycleSummary {
  evaluationCycleId: string;
  pairs: number;
  pairsSkippedUpToDate: number;
  pairsBackedOff: number;
  pairsFetched: number;
  /** Pairs evaluated entirely from stored candles (no vendor call). */
  pairsServedFromStore: number;
  candlesFetched: number;
  stalePairs: number;
  /** Distinct indicator series computed (shared by all signals of a pair). */
  indicatorSeriesComputed: number;
  evaluated: number;
  /** Definition evaluations skipped because their latest candle was already evaluated. */
  skippedUpToDate: number;
  subscriptionsEvaluated: number;
  triggered: number;
  eventsCreated: number;
  duplicatesSkipped: number;
  notificationsSent: number;
  errors: number;
  durationMs: number;
}

type ActiveDefinition = SignalDefinition & {
  state: SignalState | null;
  asset: { currency: string };
  _count: { subscriptions: number };
};

/**
 * ONE evaluation pass. Work is grouped by (ticker, timeframe): candles are loaded once per
 * pair, indicators computed once per pair (shared IndicatorContext), and every definition /
 * subscription for that pair is evaluated from that single data set. All durable state lives
 * in Postgres, so this can be driven by the interval scheduler, cron, a serverless schedule,
 * or split per pair into queue jobs later.
 */
export async function runEvaluationCycle(deps: CycleDeps): Promise<CycleSummary> {
  const started = Date.now();
  const now = deps.now?.() ?? Date.now();
  const settings: WorkerSettings = {
    ...DEFAULT_WORKER_SETTINGS,
    ...(deps.candleLookback ? { candleLookback: deps.candleLookback } : {}),
    ...(deps.fetchConcurrency ? { fetchConcurrency: deps.fetchConcurrency } : {}),
    ...deps.settings,
  };
  const runtime = deps.runtime ?? createWorkerRuntime(settings);
  const evaluationCycleId = randomUUID();
  const logger = deps.logger.child?.({ evaluationCycleId }) ?? deps.logger;
  const summary: CycleSummary = {
    evaluationCycleId,
    pairs: 0,
    pairsSkippedUpToDate: 0,
    pairsBackedOff: 0,
    pairsFetched: 0,
    pairsServedFromStore: 0,
    candlesFetched: 0,
    stalePairs: 0,
    indicatorSeriesComputed: 0,
    evaluated: 0,
    skippedUpToDate: 0,
    subscriptionsEvaluated: 0,
    triggered: 0,
    eventsCreated: 0,
    duplicatesSkipped: 0,
    notificationsSent: 0,
    errors: 0,
    durationMs: 0,
  };

  // Only definitions somebody is actually listening to, with their listener count.
  const definitions: ActiveDefinition[] = await deps.prisma.signalDefinition.findMany({
    where: { enabled: true, subscriptions: { some: { enabled: true } } },
    include: {
      state: true,
      asset: { select: { currency: true } },
      _count: { select: { subscriptions: { where: { enabled: true } } } },
    },
  });

  const groups = new Map<string, ActiveDefinition[]>();
  for (const def of definitions) {
    const key = `${def.ticker}|${def.timeframe}`;
    if (settings.shardCount > 1 && shardOf(key, settings.shardCount) !== settings.shardIndex)
      continue;
    groups.set(key, [...(groups.get(key) ?? []), def]);
  }
  summary.pairs = groups.size;

  await mapWithConcurrency(
    [...groups.entries()],
    settings.fetchConcurrency,
    async ([key, defs]) => {
      const { ticker } = defs[0]!;
      const timeframe = defs[0]!.timeframe as Timeframe;
      const pairStarted = Date.now();
      try {
        const r = await evaluatePair(
          { ...deps, logger },
          settings,
          runtime,
          key,
          ticker,
          timeframe,
          defs,
          now,
          summary,
        );
        if (r) {
          const log = r.eventsCreated > 0 ? logger.info.bind(logger) : logger.debug?.bind(logger);
          log?.(
            {
              symbol: ticker,
              timeframe,
              fetched: r.fetched,
              candlesEvaluated: r.candlesEvaluated,
              indicatorSeriesComputed: r.indicatorSeriesComputed,
              subscriptionsEvaluated: r.subscriptionsEvaluated,
              eventsCreated: r.eventsCreated,
              notificationsSent: r.notificationsSent,
              durationMs: Date.now() - pairStarted,
            },
            'pair evaluated',
          );
        }
      } catch (err) {
        summary.errors++;
        logger.error({ err, symbol: ticker, timeframe }, 'pair evaluation failed');
      }
    },
  );

  summary.durationMs = Date.now() - started;
  recordCycleMetrics(deps.metrics, summary);
  return summary;
}

function recordCycleMetrics(m: Metrics | undefined, s: CycleSummary): void {
  if (!m) return;
  m.inc('worker_cycles_total');
  m.observe('worker_cycle_duration_ms', s.durationMs);
  m.inc(
    'worker_pairs_evaluated_total',
    undefined,
    s.pairs - s.pairsSkippedUpToDate - s.pairsBackedOff,
  );
  m.inc('worker_pairs_skipped_total', { reason: 'up_to_date' }, s.pairsSkippedUpToDate);
  m.inc('worker_pairs_skipped_total', { reason: 'backoff' }, s.pairsBackedOff);
  m.inc('candle_store_hits_total', undefined, s.pairsServedFromStore);
  m.inc('candle_store_misses_total', undefined, s.pairsFetched);
  m.inc('worker_subscriptions_evaluated_total', undefined, s.subscriptionsEvaluated);
  m.inc('signals_triggered_total', undefined, s.triggered);
  m.inc('signal_events_created_total', undefined, s.eventsCreated);
  m.inc('signal_events_duplicate_total', undefined, s.duplicatesSkipped);
  m.inc('worker_pair_errors_total', undefined, s.errors);
}

interface PairResult {
  fetched: boolean;
  indicatorSeriesComputed: number;
  candlesEvaluated: number;
  subscriptionsEvaluated: number;
  eventsCreated: number;
  notificationsSent: number;
}

async function evaluatePair(
  deps: CycleDeps,
  settings: WorkerSettings,
  runtime: WorkerRuntime,
  key: string,
  ticker: string,
  timeframe: Timeframe,
  defs: ActiveDefinition[],
  now: number,
  summary: CycleSummary,
): Promise<PairResult | null> {
  const expectedLatest = latestClosedCandleOpenTime(now, timeframe, settings.candleCloseGraceMs);

  // Cheapest path: every definition already evaluated the latest closed candle.
  if (defs.every((d) => d.state && d.state.lastCandleTime.getTime() >= expectedLatest)) {
    summary.pairsSkippedUpToDate++;
    summary.skippedUpToDate += defs.length;
    return null;
  }
  if (!runtime.pairTracker.shouldFetch(key, expectedLatest, now)) {
    summary.pairsBackedOff++;
    return null;
  }

  const window = await loadCandleWindow(deps, ticker, timeframe, {
    now,
    lookback: settings.candleLookback,
    graceMs: settings.candleCloseGraceMs,
    persist: deps.ingest !== false,
  });
  runtime.pairTracker.record(key, expectedLatest, window.complete, now);
  if (window.fetched) {
    summary.pairsFetched++;
    summary.candlesFetched += window.fetchedCount;
  } else if (window.candles.length > 0) {
    summary.pairsServedFromStore++;
  }
  if (!window.complete) summary.stalePairs++;
  const { candles } = window;
  if (candles.length === 0) return null;

  // One SignalContext (candles + indicator cache) for the whole pair: EMA/RSI/MACD are
  // computed once, not per signal or per user.
  const context = createSignalContext(ticker, timeframe, candles);
  const result: PairResult = {
    fetched: window.fetched,
    indicatorSeriesComputed: 0,
    candlesEvaluated: 0,
    subscriptionsEvaluated: 0,
    eventsCreated: 0,
    notificationsSent: 0,
  };

  for (const def of defs) {
    const lastEvaluated = def.state?.lastCandleTime.getTime();
    // Candles after the last evaluated one. New definitions start at the latest candle only.
    let indices: number[] = [];
    for (let i = 0; i < candles.length; i++) {
      if (lastEvaluated === undefined ? i === candles.length - 1 : candles[i]!.time > lastEvaluated)
        indices.push(i);
    }
    if (indices.length === 0) {
      summary.skippedUpToDate++;
      continue;
    }
    // Catch up on at most N missed candles; older gaps are skipped (no stale alert floods).
    indices = indices.slice(-Math.max(1, settings.maxCatchupCandles));

    let parameters;
    try {
      parameters = parseSignalParameters(def.signalType, def.parameters);
    } catch (err) {
      summary.errors++;
      deps.logger.error({ err, definitionId: def.id }, 'invalid stored parameters - skipping');
      continue;
    }

    let previousActive: boolean | null | undefined =
      def.state &&
      indices[0]! > 0 &&
      def.state.lastCandleTime.getTime() === candles[indices[0]! - 1]!.time
        ? def.state.lastActive
        : undefined;
    let last: SignalEvaluation | undefined;
    let triggeredAny = false;

    for (const index of indices) {
      const evaluation = evaluateSignal({
        signalType: def.signalType,
        parameters,
        context,
        index,
        previousActive,
        currency: def.asset.currency,
        strengthModel: settings.strengthModel,
      });
      summary.evaluated++;
      result.candlesEvaluated++;
      result.subscriptionsEvaluated += def._count.subscriptions;
      summary.subscriptionsEvaluated += def._count.subscriptions;

      if (evaluation.triggered) {
        triggeredAny = true;
        summary.triggered++;
        deps.logger.info(
          {
            symbol: ticker,
            timeframe,
            signal: def.name,
            candleTime: new Date(candles[index]!.time).toISOString(),
            message: evaluation.message,
          },
          'signal triggered',
        );
        // Events BEFORE state: a crash in between re-evaluates the candle next cycle and the
        // unique constraint absorbs the duplicate.
        const r = await fanOutSignal(deps, def, evaluation, now);
        summary.eventsCreated += r.created;
        summary.duplicatesSkipped += r.duplicates;
        summary.notificationsSent += r.notificationsSent;
        result.eventsCreated += r.created;
        result.notificationsSent += r.notificationsSent;
      }
      previousActive = evaluation.active;
      last = evaluation;
    }
    result.indicatorSeriesComputed = context.indicators.computedSeries.length;

    if (!last || last.candleTime === null) continue;
    const stateData = {
      lastCandleTime: new Date(last.candleTime),
      lastActive: last.active,
      lastEvaluatedAt: new Date(now),
      ...(triggeredAny ? { lastTriggeredAt: new Date(now) } : {}),
    };
    await deps.prisma.signalState.upsert({
      where: { signalDefinitionId: def.id },
      update: stateData,
      create: { signalDefinitionId: def.id, ...stateData },
    });
  }
  summary.indicatorSeriesComputed += result.indicatorSeriesComputed;
  return result;
}

/** Stable shard assignment for a pair key (FNV-1a). */
export function shardOf(key: string, count: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % count;
}
