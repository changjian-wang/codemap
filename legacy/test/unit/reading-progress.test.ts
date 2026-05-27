import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: undefined },
}));

import {
  ReadingProgressStore,
  applyReadingProgress,
} from '../../src/persistence/reading-progress';
import type { CodeMapGraph, CodeNode } from '../../src/shared/types';

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

function node(id: string, methods: string[] = []): CodeNode {
  return {
    id,
    kind: 'class',
    file: `${id}.ts`,
    range: { startLine: 1, endLine: 10 },
    boundedContext: 'host',
    intent: '',
    confidence: 1,
    risks: [],
    methods: methods.map((m) => ({
      name: m,
      signature: `${m}()`,
      line: 1,
      risks: [],
      readState: 'unread' as const,
    })),
    readState: 'unread',
    verification: 'verified',
  };
}

function graph(nodes: CodeNode[]): CodeMapGraph {
  const dict: Record<string, CodeNode> = {};
  for (const n of nodes) dict[n.id] = n;
  return {
    rootRequest: '@codemap',
    scope: 'workspace',
    nodes: dict,
    edges: [],
    externalDeps: [],
  };
}

describe('ReadingProgressStore', () => {
  it('persists and reads node + method marks', async () => {
    const m = makeMemento();
    const store = new ReadingProgressStore(m.memento as never);
    await store.setNodeRead('A', true);
    await store.setMethodRead('B', 'foo', true);
    expect(store.isNodeRead('A')).toBe(true);
    expect(store.isMethodRead('B', 'foo')).toBe(true);
    expect(store.isNodeRead('C')).toBe(false);
    const snap = store.snapshot();
    expect(snap).toEqual({ 'n:A': true, 'm:B.foo': true });
  });

  it('reset clears all marks', async () => {
    const m = makeMemento();
    const store = new ReadingProgressStore(m.memento as never);
    await store.setNodeRead('A', true);
    await store.reset();
    expect(store.snapshot()).toEqual({});
  });
});

describe('applyReadingProgress', () => {
  it('returns the input graph unchanged when snapshot is empty', () => {
    const g = graph([node('A', ['foo'])]);
    const out = applyReadingProgress(g, {});
    expect(out).toBe(g);
  });

  it('flips node.readState to "read" when n:<id> is set', () => {
    const g = graph([node('A'), node('B')]);
    const out = applyReadingProgress(g, { 'n:A': true });
    expect(out.nodes.A!.readState).toBe('read');
    expect(out.nodes.B!.readState).toBe('unread');
  });

  it('flips method.readState to "read" when m:<id>.<method> is set', () => {
    const g = graph([node('A', ['foo', 'bar'])]);
    const out = applyReadingProgress(g, { 'm:A.foo': true });
    expect(out.nodes.A!.methods[0]!.readState).toBe('read');
    expect(out.nodes.A!.methods[1]!.readState).toBe('unread');
  });

  it('does not mutate the input graph', () => {
    const g = graph([node('A', ['foo'])]);
    const before = JSON.parse(JSON.stringify(g));
    applyReadingProgress(g, { 'n:A': true, 'm:A.foo': true });
    expect(g).toEqual(before);
  });

  it('ignores stale keys for nodes/methods that no longer exist', () => {
    const g = graph([node('A')]);
    const out = applyReadingProgress(g, { 'n:Z': true, 'm:A.gone': true });
    expect(out.nodes.A!.readState).toBe('unread');
  });
});
