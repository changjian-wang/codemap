/**
 * Bounded-concurrency promise pool.
 *
 * The orchestrator fans out one analyzer per skeleton file. We cap concurrency
 * so we don't trip the LM rate limit (30 files × full TS file each is well
 * within the per-minute token budget on GPT-4o / Claude 3.5, but bursts of
 * 30 simultaneous requests get throttled).
 *
 * Backpressure semantics: tasks are scheduled FIFO; each task is wrapped in a
 * try/catch so one failure does not abort the rest. Caller gets `{ value, error }`
 * per task in input order.
 *
 * Adaptive throttling: when {@link RunParallelOptions.adaptiveBackoff} is set,
 * we watch the rolling failure rate; once we hit `failureThreshold` consecutive
 * errors we insert `cooldownMs` of artificial delay before each subsequent
 * task start. This is the cheap way to survive an LM rate-limit cascade
 * without aborting the whole run.
 */

export interface PoolResult<T> {
  value?: T;
  error?: Error;
}

export interface RunParallelOptions {
  adaptiveBackoff?: {
    /** Consecutive failures before backoff kicks in. */
    failureThreshold: number;
    /** Delay inserted before each task start once threshold is reached. */
    cooldownMs: number;
  };
  /** Callback fired when backoff is triggered (for chat logging). */
  onBackoff?: (consecutiveFailures: number) => void;
}

export async function runParallel<TIn, TOut>(
  items: readonly TIn[],
  worker: (item: TIn, index: number) => Promise<TOut>,
  concurrency: number,
  options: RunParallelOptions = {},
): Promise<PoolResult<TOut>[]> {
  if (concurrency <= 0) throw new Error('concurrency must be > 0');
  if (items.length === 0) return [];

  const results = new Array<PoolResult<TOut>>(items.length);
  let cursor = 0;
  let consecutiveFailures = 0;
  let backoffActive = false;

  const runOne = async (): Promise<void> => {
    while (true) {
      const idx = cursor;
      if (idx >= items.length) return;
      cursor++;
      if (backoffActive && options.adaptiveBackoff) {
        await new Promise((r) => setTimeout(r, options.adaptiveBackoff!.cooldownMs));
      }
      try {
        results[idx] = { value: await worker(items[idx]!, idx) };
        consecutiveFailures = 0;
      } catch (e) {
        results[idx] = { error: e instanceof Error ? e : new Error(String(e)) };
        consecutiveFailures++;
        if (
          options.adaptiveBackoff &&
          !backoffActive &&
          consecutiveFailures >= options.adaptiveBackoff.failureThreshold
        ) {
          backoffActive = true;
          options.onBackoff?.(consecutiveFailures);
        }
      }
    }
  };

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, runOne);
  await Promise.all(runners);
  return results;
}
