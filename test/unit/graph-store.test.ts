import { describe, it, expect, vi } from 'vitest';

// `graph-store` imports `vscode` for `workspaceFolders` only inside
// `currentWorkspaceRevHash()` (not used by GraphStore itself). We stub the
// module so the rest of GraphStore is testable in plain Node.
vi.mock('vscode', () => ({
  workspace: { workspaceFolders: undefined },
}));

import { GraphStore, type StoredGraph } from '../../src/persistence/graph-store';
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
