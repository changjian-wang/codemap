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
 */

export interface PoolResult<T> {
  value?: T;
  error?: Error;
}

export async function runParallel<TIn, TOut>(
  items: readonly TIn[],
  worker: (item: TIn, index: number) => Promise<TOut>,
  concurrency: number,
): Promise<PoolResult<TOut>[]> {
  if (concurrency <= 0) throw new Error('concurrency must be > 0');
  if (items.length === 0) return [];

  const results = new Array<PoolResult<TOut>>(items.length);
  let cursor = 0;

  const runOne = async (): Promise<void> => {
    while (true) {
      const idx = cursor;
      if (idx >= items.length) return;
      cursor++;
      try {
        results[idx] = { value: await worker(items[idx]!, idx) };
      } catch (e) {
        results[idx] = { error: e instanceof Error ? e : new Error(String(e)) };
      }
    }
  };

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, runOne);
  await Promise.all(runners);
  return results;
}
