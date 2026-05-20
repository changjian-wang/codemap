import { describe, it, expect, vi } from 'vitest';

// `graph-store` imports `vscode` for `workspaceFolders` only inside
// `currentWorkspaceRevHash()` (not used by GraphStore itself). We stub the
// module so the rest of GraphStore is testable in plain Node.
vi.mock('vscode', () => ({
  workspace: { workspaceFolders: undefined },
}));

import { GraphStore, loadLatestGraph, type StoredGraph } from '../../src/persistence/graph-store';
import type { CodeMapGraph } from '../../src/shared/types';

function makeMemento(initial: Record<string, unknown> = {}) {
  const bag: Record<string, unknown> = { ...initial };
  return {
    bag,
    memento: {
      keys: () => Object.keys(bag),
      get<T>(key: string, defaultValue?: T): T | undefined {
        return (bag[key] as T | undefined) ?? defaultValue;
      },
      async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) delete bag[key];
        else bag[key] = value;
      },
    },
  };
}

function emptyGraph(scope = 'workspace'): CodeMapGraph {
  return {
    rootRequest: '@codemap',
    scope,
    nodes: {},
    edges: [],
    externalDeps: [],
  };
}

function makeStored(revHash: string): StoredGraph {
  return {
    graph: emptyGraph(),
    chatTurns: [],
    revHash,
    savedAt: 1,
  };
}

describe('GraphStore', () => {
  it('round-trips a stored graph', async () => {
    const m = makeMemento();
    const store = new GraphStore(m.memento as never);
    await store.save(makeStored('hash-A'));
    const loaded = store.load();
    expect(loaded?.revHash).toBe('hash-A');
  });

  it('returns undefined when revHash mismatches the expected workspace', async () => {
    const m = makeMemento();
    const store = new GraphStore(m.memento as never);
    await store.save(makeStored('hash-A'));
    expect(store.load('hash-B')).toBeUndefined();
    expect(store.load('hash-A')?.revHash).toBe('hash-A');
  });

  it('returns undefined when no graph has been saved yet', () => {
    const m = makeMemento();
    const store = new GraphStore(m.memento as never);
    expect(store.load()).toBeUndefined();
  });

  it('overwrites the previously stored graph', async () => {
    const m = makeMemento();
    const store = new GraphStore(m.memento as never);
    await store.save(makeStored('hash-A'));
    await store.save({ ...makeStored('hash-A'), savedAt: 99 });
    expect(store.load()?.savedAt).toBe(99);
  });

  it('clear() removes the stored graph', async () => {
    const m = makeMemento();
    const store = new GraphStore(m.memento as never);
    await store.save(makeStored('hash-A'));
    await store.clear();
    expect(store.load()).toBeUndefined();
  });
});

describe('GraphStore multi-root', () => {
  const uriA = { fsPath: '/repo/a' } as never;
  const uriB = { fsPath: '/repo/b' } as never;
  const folderA = { name: 'a', uri: uriA } as never;
  const folderB = { name: 'b', uri: uriB } as never;

  it('keeps graphs from different folders in separate keys', async () => {
    const m = makeMemento();
    const a = new GraphStore(m.memento as never, uriA);
    const b = new GraphStore(m.memento as never, uriB);
    await a.save({ ...makeStored('/repo/a'), savedAt: 100 });
    await b.save({ ...makeStored('/repo/b'), savedAt: 200 });
    expect(a.load()?.revHash).toBe('/repo/a');
    expect(b.load()?.revHash).toBe('/repo/b');
  });

  it('clear() on one folder leaves the other intact', async () => {
    const m = makeMemento();
    const a = new GraphStore(m.memento as never, uriA);
    const b = new GraphStore(m.memento as never, uriB);
    await a.save(makeStored('/repo/a'));
    await b.save(makeStored('/repo/b'));
    await a.clear();
    expect(a.load()).toBeUndefined();
    expect(b.load()?.revHash).toBe('/repo/b');
  });

  it('migrates legacy single-key storage on first load', async () => {
    const m = makeMemento({ 'codemap.lastGraph': makeStored('/repo/a') });
    const a = new GraphStore(m.memento as never, uriA);
    expect(a.load()?.revHash).toBe('/repo/a');
  });

  it('legacy fallback only kicks in when revHash matches the folder', async () => {
    // Legacy single-key entry from folder B should NOT surface for folder A.
    const m = makeMemento({ 'codemap.lastGraph': makeStored('/repo/b') });
    const a = new GraphStore(m.memento as never, uriA);
    expect(a.load()).toBeUndefined();
  });

  it('loadLatestGraph picks the freshest entry across folders', async () => {
    const m = makeMemento();
    const a = new GraphStore(m.memento as never, uriA);
    const b = new GraphStore(m.memento as never, uriB);
    await a.save({ ...makeStored('/repo/a'), savedAt: 100 });
    await b.save({ ...makeStored('/repo/b'), savedAt: 200 });
    const latest = loadLatestGraph(m.memento as never, [folderA, folderB]);
    expect(latest?.stored.revHash).toBe('/repo/b');
    expect((latest?.folder as { name: string } | undefined)?.name).toBe('b');
  });

  it('loadLatestGraph falls back to legacy entry when no per-root keys exist', async () => {
    const m = makeMemento({ 'codemap.lastGraph': makeStored('/repo/a') });
    const latest = loadLatestGraph(m.memento as never, [folderA]);
    expect(latest?.stored.revHash).toBe('/repo/a');
    expect((latest?.folder as { name: string } | undefined)?.name).toBe('a');
  });
});
