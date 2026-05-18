import { describe, it, expect } from 'vitest';
import { runParallel } from '../../src/orchestrator/parallel-runner';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('runParallel', () => {
  it('returns [] for empty input', async () => {
    expect(await runParallel([], async (x: number) => x, 4)).toEqual([]);
  });

  it('preserves input order in output, regardless of completion order', async () => {
    const out = await runParallel(
      [30, 10, 20],
      async ms => {
        await sleep(ms);
        return ms;
      },
      3,
    );
    expect(out.map(r => r.value)).toEqual([30, 10, 20]);
  });

  it('respects the concurrency cap (≤ N in flight at once)', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runParallel(
      items,
      async i => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight--;
        return i;
      },
      4,
    );
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('captures errors per task without aborting siblings', async () => {
    const out = await runParallel(
      [1, 2, 3],
      async i => {
        if (i === 2) throw new Error('boom');
        return i * 10;
      },
      2,
    );
    expect(out[0]!.value).toBe(10);
    expect(out[1]!.error?.message).toBe('boom');
    expect(out[2]!.value).toBe(30);
  });

  it('throws when concurrency is 0 or negative', async () => {
    await expect(runParallel([1], async () => 1, 0)).rejects.toThrow(/concurrency/);
  });
});
