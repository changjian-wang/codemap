import { describe, it, expect } from 'vitest';
import { computeReadingOrder, isTestNode } from '../../src/graph/reading-order';
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

  it('demotes test classes below production entries', () => {
    // Both nodes have in-degree 0 (no inbound calls), so both qualify as
    // entries. With equal confidence, production must lead.
    const graph = G([
      N('TestFoo', { file: 'tests/test_foo.py' }),
      N('FooService', { file: 'src/foo_service.py' }),
    ]);
    expect(computeReadingOrder(graph)).toEqual(['FooService', 'TestFoo']);
  });

  it('keeps production tree before test tree when both are independent entries', () => {
    // Both production and test classes are in-degree 0 (independent entries).
    // The fix demotes test to after production regardless of confidence.
    const graph = G(
      [
        N('FileSearchBackend', { file: 'src/_file_search.py', confidence: 0.7 }),
        N('TestFileSearch', { file: 'tests/test_file_search.py', confidence: 0.95 }),
        N('Helper', { file: 'src/_helper.py' }),
      ],
      [
        { from: 'FileSearchBackend', to: 'Helper' },
        { from: 'TestFileSearch', to: 'Helper' },
      ],
    );
    const order = computeReadingOrder(graph);
    // FileSearchBackend leads despite lower confidence; test entry trails.
    expect(order[0]).toBe('FileSearchBackend');
    expect(order.indexOf('TestFileSearch')).toBeGreaterThan(
      order.indexOf('FileSearchBackend'),
    );
  });

  it('ranks Program/Startup-style roots above routing-surface entries', () => {
    // Both qualify as entries (in-degree 0). The LLM commonly fails to wire
    // `Program → RecallEndpoints` because the call goes through DI; without
    // the filename signal, RecallEndpoints would beat Program on confidence
    // ties. The filename heuristic encodes the convention so the reviewer
    // sees the real composition root first.
    const graph = G([
      N('RecallEndpoints', {
        file: 'apps/api/src/Lumen.Modules.Recall/Endpoints/RecallEndpoints.cs',
        confidence: 0.95,
      }),
      N('Program', {
        file: 'apps/api/src/Lumen.Host/Program.cs',
        confidence: 0.8,
      }),
    ]);
    expect(computeReadingOrder(graph)).toEqual(['Program', 'RecallEndpoints']);
  });

  it('breaks filename/test-rank ties by in-degree (true topo root wins)', () => {
    // Two ordinary-named files. One has in-degree 0; the other is reachable
    // via layer:entry plus an inbound edge. The topological root must lead.
    const graph = G(
      [
        N('CalledEntry', { layer: 'entry' }),
        N('RealRoot'),
      ],
      [{ from: 'RealRoot', to: 'CalledEntry' }],
    );
    expect(computeReadingOrder(graph)).toEqual(['RealRoot', 'CalledEntry']);
  });

  it('breaks filename/in-degree ties by out-degree (wider wiring wins)', () => {
    // Both in-degree 0, neither matches a name convention. The one that
    // wires up more dependencies is more likely the real composition root.
    const graph = G(
      [
        N('NarrowRoot'),
        N('WideRoot'),
        N('A'),
        N('B'),
      ],
      [
        { from: 'WideRoot', to: 'A' },
        { from: 'WideRoot', to: 'B' },
        { from: 'NarrowRoot', to: 'A' },
      ],
    );
    const order = computeReadingOrder(graph);
    expect(order.indexOf('WideRoot')).toBeLessThan(order.indexOf('NarrowRoot'));
  });
});

describe('isTestNode', () => {
  const make = (file: string): CodeNode => N('X', { file });

  it.each([
    ['tests/cu/test_models.py', true],
    ['src/agent/tests/test_foo.py', true],
    ['packages/foo/__tests__/bar.ts', true],
    ['src/spec/foo.cs', true],
    ['app/test_foo.py', true],
    ['app/foo_test.go', true],
    ['app/foo.test.ts', true],
    ['app/foo.spec.ts', true],
    ['src/FooTests.cs', true],
    ['src/BarTest.java', true],
    // pytest convention: any `test_*.py` is a test file, regardless of dir.
    ['src/agent_framework/test_runner_config.py', true],
  ])('flags %s as test', (file, expected) => {
    expect(isTestNode(make(file))).toBe(expected);
  });

  it.each([
    ['src/testing.py', false], // utility, not a test
    ['src/protester.ts', false],
    ['src/contesting.cs', false],
    ['src/foo.py', false],
    ['samples/01-get-started/01_document_qa.py', false],
  ])('does not flag %s', (file, _expected) => {
    expect(isTestNode(make(file))).toBe(false);
  });
});
