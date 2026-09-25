import type { PrismaClient, SignalDefinition, SignalState } from '@signals/db';
import type { MarketDataProvider } from '@signals/market-data';
import type { Logger, NotificationSender } from '@signals/notifications';
import {
  IndicatorContext,
  completedCandles,
  evaluateSignal,
  parseSignalParameters,
} from '@signals/signal-engine';
import type { Timeframe } from '@signals/types';
import { mapWithConcurrency } from './concurrency';
import { fanOutSignal } from './deliver';
import { ingestCandles } from './ingest';

export interface CycleDeps {
  prisma: PrismaClient;
  marketData: MarketDataProvider;
  notifier: NotificationSender;
  logger: Logger;
  now?: () => number;
  candleLookback?: number;
  fetchConcurrency?: number;
  /** Persist fetched candles to MarketCandle (default true). */
  ingest?: boolean;
}

export interface CycleSummary {
  pairs: number;
  evaluated: number;
  skippedUpToDate: number;
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
};

/**
 * ONE evaluation pass over every active (ticker, timeframe) pair. Stateless between calls
 * (all state lives in Postgres), so it can be driven by the interval scheduler here, a cron
 * job, a serverless schedule, or split per pair into BullMQ jobs later.
 */
export async function runEvaluationCycle(deps: CycleDeps): Promise<CycleSummary> {
  const started = Date.now();
  const now = deps.now?.() ?? Date.now();
  const summary: CycleSummary = {
    pairs: 0,
    evaluated: 0,
    skippedUpToDate: 0,
    triggered: 0,
    eventsCreated: 0,
    duplicatesSkipped: 0,
    notificationsSent: 0,
    errors: 0,
    durationMs: 0,
  };

  // Only definitions somebody is actually listening to.
  const definitions: ActiveDefinition[] = await deps.prisma.signalDefinition.findMany({
    where: { enabled: true, subscriptions: { some: { enabled: true } } },
    include: { state: true, asset: { select: { currency: true } } },
  });

  const groups = new Map<string, ActiveDefinition[]>();
  for (const def of definitions) {
    const key = `${def.ticker}|${def.timeframe}`;
    groups.set(key, [...(groups.get(key) ?? []), def]);
  }
  summary.pairs = groups.size;

  await mapWithConcurrency([...groups.values()], deps.fetchConcurrency ?? 4, async (defs) => {
    const { ticker } = defs[0]!;
    const timeframe = defs[0]!.timeframe as Timeframe;
    try {
      await evaluatePair(deps, ticker, timeframe, defs, now, summary);
    } catch (err) {
      summary.errors++;
      deps.logger.error({ err, ticker, timeframe }, 'pair evaluation failed');
    }
  });

  summary.durationMs = Date.now() - started;
  return summary;
}

async function evaluatePair(
  deps: CycleDeps,
  ticker: string,
  timeframe: Timeframe,
  defs: ActiveDefinition[],
  now: number,
  summary: CycleSummary,
): Promise<void> {
  const raw = await deps.marketData.getHistoricalCandles(
    ticker,
    timeframe,
    deps.candleLookback ?? 250,
  );
  // Signals are confirmed on COMPLETED candles only - the in-progress candle is dropped.
  const candles = completedCandles(raw, timeframe, now);
  if (candles.length === 0) return;
  if (deps.ingest !== false) {
    await ingestCandles(deps.prisma, ticker, timeframe, candles, deps.marketData.name);
  }

  const latest = candles.at(-1)!;
  const previous = candles.at(-2);
  const context = new IndicatorContext(candles);

  for (const def of defs) {
    if (def.state && def.state.lastCandleTime.getTime() >= latest.time) {
      summary.skippedUpToDate++;
      continue; // this candle was already evaluated for this definition
    }

    let parameters;
    try {
      parameters = parseSignalParameters(def.signalType, def.parameters);
    } catch (err) {
      summary.errors++;
      deps.logger.error({ err, definitionId: def.id }, 'invalid stored parameters - skipping');
      continue;
    }

    // Prefer the persisted condition for the immediately preceding candle (transition
    // tracking); if we have a gap (first run, downtime) recompute it from candles.
    const previousActive =
      def.state && previous && def.state.lastCandleTime.getTime() === previous.time
        ? def.state.lastActive
        : undefined;

    const evaluation = evaluateSignal({
      signalType: def.signalType,
      parameters,
      context,
      previousActive,
      currency: def.asset.currency,
    });
    summary.evaluated++;

    if (evaluation.triggered) {
      summary.triggered++;
      deps.logger.info(
        {
          ticker,
          timeframe,
          signal: def.name,
          candleTime: new Date(latest.time).toISOString(),
          message: evaluation.message,
        },
        'signal triggered',
      );
      // Events BEFORE state: a crash in between just re-evaluates the candle next cycle,
      // and the unique constraint absorbs the duplicate.
      const r = await fanOutSignal(deps, def, evaluation);
      summary.eventsCreated += r.created;
      summary.duplicatesSkipped += r.duplicates;
      summary.notificationsSent += r.notificationsSent;
    }

    const stateData = {
      lastCandleTime: new Date(latest.time),
      lastActive: evaluation.active,
      lastEvaluatedAt: new Date(now),
      ...(evaluation.triggered ? { lastTriggeredAt: new Date(now) } : {}),
    };
    await deps.prisma.signalState.upsert({
      where: { signalDefinitionId: def.id },
      update: stateData,
      create: { signalDefinitionId: def.id, ...stateData },
    });
  }
}
