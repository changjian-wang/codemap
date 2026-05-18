import { describe, it, expect } from 'vitest';
import { scoreGraph } from '../../src/eval/score';
import type { CodeMapGraph, CodeNode } from '../../src/shared/types';
import type { GoldenSample } from '../../src/eval/score';

const N = (id: string, file: string): CodeNode => ({
  id, kind: 'class',
  file,
  range: { startLine: 1, endLine: 10 },
  boundedContext: 'shared',
  intent: '',
  confidence: 0.9,
  risks: [],
  methods: [],
  readState: 'unread',
  verification: 'verified',
});

const G = (
  nodes: CodeNode[],
  edges: { from: string; to: string }[] = [],
): CodeMapGraph => ({
  rootRequest: 'test',
  scope: 'workspace',
  nodes: Object.fromEntries(nodes.map(n => [n.id, n])),
  edges: edges.map(e => ({ ...e, kind: 'calls', verified: true })),
  externalDeps: [],
});

const GOLDEN_FULL: GoldenSample = {
  name: 'test',
  nodes: ['A', 'B', 'C'],
  edges: [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }],
};

describe('scoreGraph', () => {
  it('returns 0 / 0 / 0 when actual is empty', () => {
    const r = scoreGraph(G([]), GOLDEN_FULL);
    expect(r.nodes.precision).toBe(0);
    expect(r.nodes.recall).toBe(0);
    expect(r.nodes.f1).toBe(0);
    expect(r.diff.missingNodes).toEqual(['A', 'B', 'C']);
  });

  it('returns 1.0 perfect score when actual matches golden exactly', () => {
    const actual = G(
      [N('A', 'a.ts'), N('B', 'b.ts'), N('C', 'c.ts')],
      [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }],
    );
    const r = scoreGraph(actual, GOLDEN_FULL);
    expect(r.nodes.precision).toBe(1);
    expect(r.nodes.recall).toBe(1);
    expect(r.nodes.f1).toBe(1);
    expect(r.edges.precision).toBe(1);
    expect(r.edges.recall).toBe(1);
  });

  it('penalises extra nodes via precision, missing nodes via recall', () => {
    const actual = G([
      N('A', 'a.ts'), N('B', 'b.ts'),     // both in golden (good)
      N('D', 'd.ts'), N('E', 'e.ts'),     // extra (bad for precision)
                                          // C missing (bad for recall)
    ]);
    const r = scoreGraph(actual, GOLDEN_FULL);
    expect(r.nodes.precision).toBe(2 / 4);
    expect(r.nodes.recall).toBe(2 / 3);
    expect(r.diff.missingNodes).toEqual(['C']);
    expect(r.diff.extraNodes.sort()).toEqual(['D', 'E']);
  });

  it('honours scopeFiles to filter actual nodes before scoring', () => {
    // Golden is scoped to only Capture; actual produced nodes from both
    // Capture and Recall. The Recall nodes must not count as extras.
    const golden: GoldenSample = {
      ...GOLDEN_FULL,
      scopeFiles: ['Capture/'],
      nodes: ['A'],
      edges: [],
    };
    const actual = G([
      N('A', 'Capture/a.ts'),
      N('Z', 'Recall/z.ts'),
    ]);
    const r = scoreGraph(actual, golden);
    expect(r.nodes.precision).toBe(1);  // Z filtered out
    expect(r.nodes.recall).toBe(1);
  });

  it('scores edges only when source node is in scope', () => {
    const golden: GoldenSample = {
      name: 't',
      scopeFiles: ['in/'],
      nodes: ['A', 'B'],
      edges: [{ from: 'A', to: 'B' }],
    };
    const actual = G(
      [N('A', 'in/a.ts'), N('B', 'in/b.ts'), N('Z', 'out/z.ts')],
      [{ from: 'A', to: 'B' }, { from: 'Z', to: 'A' }],
    );
    const r = scoreGraph(actual, golden);
    expect(r.edges.precision).toBe(1);
    expect(r.edges.recall).toBe(1);
  });

  it('computes F1 correctly when precision and recall diverge', () => {
    const actual = G(
      [N('A', 'a.ts'), N('B', 'b.ts'), N('X', 'x.ts')],
      [],
    );
    const golden: GoldenSample = { name: 't', nodes: ['A', 'B', 'C'], edges: [] };
    const r = scoreGraph(actual, golden);
    expect(r.nodes.precision).toBeCloseTo(2 / 3);
    expect(r.nodes.recall).toBeCloseTo(2 / 3);
    expect(r.nodes.f1).toBeCloseTo(2 / 3);
  });

  it('reports edge diff (missing + extra) explicitly', () => {
    const actual = G(
      [N('A', 'a.ts'), N('B', 'b.ts'), N('C', 'c.ts')],
      [{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }],
    );
    const golden: GoldenSample = {
      name: 't',
      nodes: ['A', 'B', 'C'],
      edges: [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }],
    };
    const r = scoreGraph(actual, golden);
    expect(r.diff.missingEdges).toEqual([{ from: 'B', to: 'C' }]);
    expect(r.diff.extraEdges).toEqual([{ from: 'A', to: 'C' }]);
  });
});
