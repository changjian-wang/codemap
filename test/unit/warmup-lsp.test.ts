import { describe, it, expect } from 'vitest';
import type * as vscode from 'vscode';
import { warmupLsp } from '../../src/orchestrator/orchestrator';

const NEVER_CANCELLED = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
} as unknown as vscode.CancellationToken;

const CANCELLED = {
  isCancellationRequested: true,
  onCancellationRequested: () => ({ dispose() {} }),
} as unknown as vscode.CancellationToken;

function makeSymbols(
  script: Record<string, Array<unknown[] | undefined | null>>,
): { symbolsInFile: (f: string) => Promise<unknown> } {
  const cursors: Record<string, number> = {};
  return {
    async symbolsInFile(f: string) {
      const stream = script[f];
      if (!stream) return undefined;
      const i = Math.min(cursors[f] ?? 0, stream.length - 1);
      cursors[f] = (cursors[f] ?? 0) + 1;
      return stream[i];
    },
  };
}

describe('warmupLsp', () => {
  it('reports ready immediately once a target returns a non-empty symbol list', async () => {
    const symbols = makeSymbols({
      'Program.cs': [[{}]], // first poll already non-empty
    });
    const ok = await warmupLsp(symbols, ['Program.cs'], NEVER_CANCELLED, {
      timeoutMs: 1000,
      pollMs: 10,
    });
    expect(ok).toBe(true);
  });

  it('keeps polling while LSP returns undefined (still booting)', async () => {
    const symbols = makeSymbols({
      'Program.cs': [undefined, undefined, [{ name: 'Foo' }]],
    });
    const ok = await warmupLsp(symbols, ['Program.cs'], NEVER_CANCELLED, {
      timeoutMs: 1000,
      pollMs: 10,
    });
    expect(ok).toBe(true);
  });

  it('keeps polling while LSP returns [] (C# Dev Kit indexing) — does NOT short-circuit on empty array', async () => {
    // This is the regression test for the lumen "everything is unverified
    // even after warmup said OK" bug. C# Dev Kit returns `[]` for several
    // seconds during indexing; the old warmup treated that as ready and we
    // calibrated every file against still-empty symbol lists.
    const symbols = makeSymbols({
      'Program.cs': [[], [], [], [{ name: 'Lumen.Host.Program' }]],
    });
    const ok = await warmupLsp(symbols, ['Program.cs'], NEVER_CANCELLED, {
      timeoutMs: 1000,
      pollMs: 5,
    });
    expect(ok).toBe(true);
  });

  it('considers the run ready as soon as ANY of the targets goes non-empty', async () => {
    // The first target never produces symbols, the second one does on the
    // second round. Warmup should not block on the first target.
    const symbols = makeSymbols({
      'A.cs': [undefined, undefined, undefined, undefined],
      'B.cs': [undefined, [{ name: 'B' }]],
    });
    const ok = await warmupLsp(symbols, ['A.cs', 'B.cs'], NEVER_CANCELLED, {
      timeoutMs: 1000,
      pollMs: 10,
    });
    expect(ok).toBe(true);
  });

  it('returns false when the timeout elapses with only [] / undefined responses', async () => {
    const symbols = makeSymbols({
      'A.cs': [undefined, [], [], [], [], [], [], []],
    });
    const ok = await warmupLsp(symbols, ['A.cs'], NEVER_CANCELLED, {
      timeoutMs: 50,
      pollMs: 5,
    });
    expect(ok).toBe(false);
  });

  it('honours the cancellation token between polls', async () => {
    const symbols = makeSymbols({
      'A.cs': [undefined, undefined, [{ name: 'X' }]],
    });
    const ok = await warmupLsp(symbols, ['A.cs'], CANCELLED, {
      timeoutMs: 1000,
      pollMs: 10,
    });
    expect(ok).toBe(false);
  });

  it('accepts a single string target for ergonomics', async () => {
    const symbols = makeSymbols({
      'Program.cs': [[{ name: 'Foo' }]],
    });
    const ok = await warmupLsp(symbols, 'Program.cs', NEVER_CANCELLED, {
      timeoutMs: 100,
      pollMs: 5,
    });
    expect(ok).toBe(true);
  });

  it('returns false when given an empty targets list', async () => {
    const symbols = makeSymbols({});
    const ok = await warmupLsp(symbols, [], NEVER_CANCELLED, {
      timeoutMs: 50,
      pollMs: 5,
    });
    expect(ok).toBe(false);
  });
});
