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

  describe('ignoreEdgeToPrefixes (v3.7.1 — strip BCL / infra noise)', () => {
    it('drops matching edges from BOTH sides so neither precision nor recall is biased', () => {
      // actual has 1 business edge (A→B), 1 BCL noise edge (A→ext:File).
      // golden expects 1 business edge (A→B), 1 BCL noise edge (A→ext:JsonDocument).
      // Without ignore: actual={A→B, A→ext:File}, expected={A→B, A→ext:JsonDocument}
      //   → P = 1/2 = 0.5, R = 1/2 = 0.5
      // With `ignoreEdgeToPrefixes: ['ext:File', 'ext:JsonDocument']`:
      //   actual_filtered = {A→B}, expected_filtered = {A→B}
      //   → P = R = 1.0
      const actual = G(
        [N('A', 'a.ts'), N('B', 'b.ts')],
        [{ from: 'A', to: 'B' }, { from: 'A', to: 'ext:File.WriteAllText' }],
      );
      const golden: GoldenSample = {
        name: 't',
        nodes: ['A', 'B'],
        edges: [
          { from: 'A', to: 'B' },
          { from: 'A', to: 'ext:JsonDocument', kind: 'external_calls' },
        ],
        ignoreEdgeToPrefixes: ['ext:File', 'ext:JsonDocument'],
      };
      const r = scoreGraph(actual, golden);
      expect(r.edges.precision).toBe(1);
      expect(r.edges.recall).toBe(1);
      // Diff should also reflect post-ignore reality.
      expect(r.diff.missingEdges).toEqual([]);
      expect(r.diff.extraEdges).toEqual([]);
    });

    it('matches by prefix (e.g. `ext:Dapper` covers `ext:Dapper.CommandDefinition`)', () => {
      const actual = G(
        [N('A', 'a.ts')],
        [
          { from: 'A', to: 'ext:Dapper' },
          { from: 'A', to: 'ext:Dapper.CommandDefinition' },
          { from: 'A', to: 'ext:Dawning.Sdk' }, // not ignored (Dawning is business)
        ],
      );
      const golden: GoldenSample = {
        name: 't',
        nodes: ['A'],
        edges: [{ from: 'A', to: 'ext:Dawning.Sdk', kind: 'external_calls' }],
        ignoreEdgeToPrefixes: ['ext:Dapper'],
      };
      const r = scoreGraph(actual, golden);
      // After filter: actual = {A→ext:Dawning.Sdk}, expected = {A→ext:Dawning.Sdk}
      expect(r.edges.precision).toBe(1);
      expect(r.edges.recall).toBe(1);
    });

    it('is a no-op when the field is missing (backward compat)', () => {
      const actual = G(
        [N('A', 'a.ts'), N('B', 'b.ts')],
        [{ from: 'A', to: 'B' }, { from: 'A', to: 'ext:File.WriteAllText' }],
      );
      const golden: GoldenSample = {
        name: 't',
        nodes: ['A', 'B'],
        edges: [{ from: 'A', to: 'B' }],
        // no ignoreEdgeToPrefixes
      };
      const r = scoreGraph(actual, golden);
      // ext:File.WriteAllText is an extra edge — precision should still be penalised.
      expect(r.edges.precision).toBe(1 / 2);
      expect(r.edges.recall).toBe(1);
    });
  });

  describe('ext: name canonicalisation (v0.0.7 — bare ↔ FQN aliasing)', () => {
    it('collapses bare ↔ FQN of the same external symbol into one edge', () => {
      // actual emits bare `ext:AssemblyMarker`; golden carries the FQN
      // `ext:Lumen.Modules.Capture.AssemblyMarker`. Before v0.0.7 this
      // counted as one missing + one extra; now they collapse to a hit.
      const actual = G(
        [N('A', 'a.ts')],
        [{ from: 'A', to: 'ext:AssemblyMarker' }],
      );
      const golden: GoldenSample = {
        name: 't',
        nodes: ['A'],
        edges: [
          { from: 'A', to: 'ext:Lumen.Modules.Capture.AssemblyMarker', kind: 'external_calls' },
        ],
      };
      const r = scoreGraph(actual, golden);
      expect(r.edges.precision).toBe(1);
      expect(r.edges.recall).toBe(1);
      expect(r.diff.missingEdges).toEqual([]);
      expect(r.diff.extraEdges).toEqual([]);
    });

    it('is symmetric — golden bare vs actual FQN also collapses', () => {
      const actual = G(
        [N('A', 'a.ts')],
        [{ from: 'A', to: 'ext:Pgvector.Vector' }],
      );
      const golden: GoldenSample = {
        name: 't',
        nodes: ['A'],
        edges: [{ from: 'A', to: 'ext:Vector', kind: 'external_calls' }],
      };
      const r = scoreGraph(actual, golden);
      expect(r.edges.precision).toBe(1);
      expect(r.edges.recall).toBe(1);
    });

    it('does NOT collide two distinct FQN namespaces sharing a type name', () => {
      // Both ext:Foo.Marker and ext:Bar.Marker should stay distinct —
      // collapse only happens when at least one side is bare.
      const actual = G(
        [N('A', 'a.ts')],
        [{ from: 'A', to: 'ext:Foo.Marker' }],
      );
      const golden: GoldenSample = {
        name: 't',
        nodes: ['A'],
        edges: [{ from: 'A', to: 'ext:Bar.Marker', kind: 'external_calls' }],
      };
      const r = scoreGraph(actual, golden);
      expect(r.edges.precision).toBe(0);
      expect(r.edges.recall).toBe(0);
      expect(r.diff.missingEdges).toEqual([{ from: 'A', to: 'ext:Bar.Marker' }]);
      expect(r.diff.extraEdges).toEqual([{ from: 'A', to: 'ext:Foo.Marker' }]);
    });

    it('leaves non-ext: edges untouched (workspace symbols never canonicalise)', () => {
      // Workspace classes are identified by short id only; we must not
      // treat `Foo.Bar` as an aliasable FQN here. (This is a defensive
      // test — workspace ids never contain dots — but pins the contract.)
      const actual = G(
        [N('Foo', 'a.ts'), N('Bar', 'b.ts')],
        [{ from: 'Foo', to: 'Bar' }],
      );
      const golden: GoldenSample = {
        name: 't',
        nodes: ['Foo', 'Bar'],
        edges: [{ from: 'Foo', to: 'Bar' }],
      };
      const r = scoreGraph(actual, golden);
      expect(r.edges.precision).toBe(1);
      expect(r.edges.recall).toBe(1);
    });

    it('applies ignoreEdgeToPrefixes BEFORE canonicalisation', () => {
      // `ext:System.Foo` is ignored, so the bare `ext:Foo` from actual
      // should NOT canonicalise to the filtered-out FQN.
      const actual = G(
        [N('A', 'a.ts')],
        [{ from: 'A', to: 'ext:Foo' }],
      );
      const golden: GoldenSample = {
        name: 't',
        nodes: ['A'],
        edges: [{ from: 'A', to: 'ext:System.Foo', kind: 'external_calls' }],
        ignoreEdgeToPrefixes: ['ext:System'],
      };
      const r = scoreGraph(actual, golden);
      // After ignore filter: golden side has nothing; actual still has
      // bare ext:Foo, which becomes an extra (legitimate — golden filtered it).
      expect(r.edges.recall).toBe(0); // 0/0 → defined as 0
      expect(r.diff.extraEdges).toEqual([{ from: 'A', to: 'ext:Foo' }]);
    });

    it('three-way collapse: bare + two FQNs collapse onto the longest', () => {
      // actual has bare + short FQN, golden has long FQN.
      // All three should collapse to the longest form.
      const actual = G(
        [N('A', 'a.ts'), N('B', 'b.ts'), N('C', 'c.ts')],
        [
          { from: 'A', to: 'ext:Marker' },
          { from: 'B', to: 'ext:Capture.Marker' },
        ],
      );
      const golden: GoldenSample = {
        name: 't',
        nodes: ['A', 'B', 'C'],
        edges: [
          { from: 'A', to: 'ext:Lumen.Modules.Capture.Marker', kind: 'external_calls' },
          { from: 'B', to: 'ext:Lumen.Modules.Capture.Marker', kind: 'external_calls' },
          { from: 'C', to: 'ext:Lumen.Modules.Capture.Marker', kind: 'external_calls' },
        ],
      };
      const r = scoreGraph(actual, golden);
      // A and B match after canonicalisation, C is genuinely missing.
      expect(r.edges.precision).toBe(1);
      expect(r.edges.recall).toBeCloseTo(2 / 3);
      expect(r.diff.missingEdges).toEqual([
        { from: 'C', to: 'ext:Lumen.Modules.Capture.Marker' },
      ]);
      expect(r.diff.extraEdges).toEqual([]);
    });
  });
});
