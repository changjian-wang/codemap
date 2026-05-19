import { describe, it, expect, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { AnalyzerCache } from '../../src/persistence/analyzer-cache';
import type { AnalyzeResult } from '../../src/orchestrator/single-file-analyzer';

/** Minimal in-memory Memento for unit tests. */
function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: (<T>(key: string, defaultValue?: T): T | undefined => {
      return (store.has(key) ? (store.get(key) as T) : defaultValue) as T | undefined;
    }) as vscode.Memento['get'],
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
    keys: () => [...store.keys()],
  };
}

/**
 * Builds a minimal AnalyzeResult — only the shape is checked by the cache,
 * not the contents, so we keep it minimal.
 */
function fakeResult(file: string): AnalyzeResult {
  return {
    file,
    nodes: [
      {
        id: `n:${file}`,
        kind: 'class',
        label: 'Foo',
        intent: 'fake',
        boundedContext: 'Shared',
        confidence: 'high',
        readState: 'unread',
        risks: [],
        verification: { status: 'partial' },
        range: { startLine: 1, endLine: 5 },
        methods: [],
      },
    ],
    edges: [],
    warnings: [],
  } as unknown as AnalyzeResult;
}

describe('AnalyzerCache', () => {
  let memento: vscode.Memento;

  beforeEach(() => {
    memento = makeMemento();
  });

  it('returns undefined on miss', () => {
    const cache = new AnalyzerCache(memento);
    expect(cache.get('nope')).toBeUndefined();
  });

  it('round-trips set → get', async () => {
    const cache = new AnalyzerCache(memento);
    const key = AnalyzerCache.key('v1', 'a.ts', 'const x = 1;');
    await cache.set(key, fakeResult('a.ts'));
    const got = cache.get(key);
    expect(got).toBeDefined();
    expect(got!.file).toBe('a.ts');
  });

  it('key() is deterministic and content-sensitive', () => {
    const k1 = AnalyzerCache.key('v1', 'a.ts', 'X');
    const k2 = AnalyzerCache.key('v1', 'a.ts', 'X');
    const k3 = AnalyzerCache.key('v1', 'a.ts', 'Y');
    const k4 = AnalyzerCache.key('v2', 'a.ts', 'X');
    const k5 = AnalyzerCache.key('v1', 'b.ts', 'X');
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).not.toBe(k4);
    expect(k1).not.toBe(k5);
  });

  it('LRU-evicts oldest entries when capacity exceeded', async () => {
    const cache = new AnalyzerCache(memento, 3);
    const keys = ['k1', 'k2', 'k3', 'k4'];
    for (const k of keys) {
      await cache.set(k, fakeResult(k));
    }
    expect(cache.size()).toBe(3);
    // k1 should have been evicted (oldest).
    expect(cache.get('k1')).toBeUndefined();
    expect(cache.get('k2')).toBeDefined();
    expect(cache.get('k3')).toBeDefined();
    expect(cache.get('k4')).toBeDefined();
  });

  it('get() bumps recency so the touched entry survives eviction', async () => {
    const cache = new AnalyzerCache(memento, 3);
    await cache.set('k1', fakeResult('k1'));
    await cache.set('k2', fakeResult('k2'));
    await cache.set('k3', fakeResult('k3'));
    // Touch k1 → now k2 should be the LRU candidate.
    expect(cache.get('k1')).toBeDefined();
    await cache.set('k4', fakeResult('k4'));
    expect(cache.get('k1')).toBeDefined();
    expect(cache.get('k2')).toBeUndefined();
    expect(cache.get('k3')).toBeDefined();
    expect(cache.get('k4')).toBeDefined();
  });

  it('clear() drops all entries', async () => {
    const cache = new AnalyzerCache(memento);
    await cache.set('k1', fakeResult('k1'));
    await cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get('k1')).toBeUndefined();
  });
});
