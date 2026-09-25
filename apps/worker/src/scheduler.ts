import type { Logger } from '@signals/notifications';

export interface Scheduler {
  stop(): Promise<void>;
}

/**
 * Minimal in-process scheduler: runs `task` immediately, then `intervalMs` after each run
 * COMPLETES (never overlapping). Replaceable by BullMQ repeatable jobs / cron / a serverless
 * schedule because the task itself (`runEvaluationCycle`) is stateless.
 */
export function startScheduler(opts: { intervalMs: number; task: () => Promise<void>; logger: Logger }): Scheduler {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    running = opts.task().catch((err) => opts.logger.error({ err }, 'scheduled task failed'));
    await running;
    running = undefined;
    if (!stopped) timer = setTimeout(() => void tick(), opts.intervalMs);
  };
  void tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
