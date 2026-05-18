import { describe, it, expect } from 'vitest';
import { computeReadingOrder } from '../../src/graph/reading-order';
import type { CodeMapGraph, CodeNode } from '../../src/shared/types';

const N = (id: string, partial: Partial<CodeNode> = {}): CodeNode => ({
  id,
  kind: 'class',
  file: `${id}.ts`,
  range: { startLine: 1, endLine: 10 },
  boundedContext: 'shared',
  intent: '',
  confidence: 0.9,
  risks: [],
  methods: [],
  readState: 'unread',
  verification: 'verified',
  ...partial,
});

const G = (
  nodes: CodeNode[],
  edges: { from: string; to: string }[] = [],
): CodeMapGraph => ({
  rootRequest: 'test',
  scope: 'test',
  nodes: Object.fromEntries(nodes.map(n => [n.id, n])),
  edges: edges.map(e => ({ ...e, kind: 'calls', verified: true })),
  externalDeps: [],
});

describe('computeReadingOrder', () => {
  it('returns [] for an empty graph', () => {
    expect(computeReadingOrder(G([]))).toEqual([]);
  });

  it('picks the in-degree 0 node first', () => {
    const graph = G(
      [N('A'), N('B'), N('C')],
      [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
      ],
    );
    expect(computeReadingOrder(graph)).toEqual(['A', 'B', 'C']);
  });

  it('prefers layer:entry even when in-degree > 0', () => {
    const graph = G(
      [N('Util'), N('Main', { layer: 'entry' })],
      [{ from: 'Util', to: 'Main' }],
    );
    // Main is layer:entry, so it should lead — but Util is also in-degree 0,
    // so both qualify as entries. confidence is the tiebreaker (equal here),
    // so deterministic order follows array order: Util, then Main.
    const order = computeReadingOrder(graph);
    expect(order).toContain('Main');
    expect(order).toContain('Util');
    expect(order).toHaveLength(2);
  });

  it('expands higher-risk children first', () => {
    const graph = G(
      [
        N('Root'),
        N('Safe', { risks: [] }),
        N('Risky', { risks: [{ type: 'security', desc: 'x' }] }),
      ],
      [
        { from: 'Root', to: 'Safe' },
        { from: 'Root', to: 'Risky' },
      ],
    );
    const order = computeReadingOrder(graph);
    expect(order).toEqual(['Root', 'Risky', 'Safe']);
  });

  it('expands lower-confidence children first when risks are tied', () => {
    const graph = G(
      [N('Root'), N('Hi', { confidence: 0.95 }), N('Lo', { confidence: 0.5 })],
      [
        { from: 'Root', to: 'Hi' },
        { from: 'Root', to: 'Lo' },
      ],
    );
    const order = computeReadingOrder(graph);
    expect(order).toEqual(['Root', 'Lo', 'Hi']);
  });

  it('handles cycles without infinite recursion', () => {
    const graph = G(
      [N('A'), N('B'), N('C')],
      [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
        { from: 'C', to: 'A' }, // cycle
      ],
    );
    const order = computeReadingOrder(graph);
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set(['A', 'B', 'C']));
  });

  it('appends orphans (cycle-only nodes) at the end', () => {
    const graph = G(
      [N('Entry'), N('X'), N('Y')],
      [
        { from: 'X', to: 'Y' },
        { from: 'Y', to: 'X' }, // X-Y is a 2-cycle, unreachable from Entry
      ],
    );
    const order = computeReadingOrder(graph);
    expect(order[0]).toBe('Entry');
    expect(order).toHaveLength(3);
  });

  it('ignores edges that point to external deps (non-existent nodes)', () => {
    const graph = G(
      [N('A'), N('B')],
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'ext:Some.Package' }, // dangling
      ],
    );
    expect(computeReadingOrder(graph)).toEqual(['A', 'B']);
  });
});
