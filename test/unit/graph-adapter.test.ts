import { describe, it, expect } from 'vitest';
import { adaptGraphForMockup } from '../../src/webview/graph-adapter';
import type { CodeMapGraph } from '../../src/shared/types';

const GRAPH: CodeMapGraph = {
  rootRequest: 'test',
  scope: 'workspace',
  nodes: {
    Foo: {
      id: 'Foo',
      kind: 'class',
      file: 'src/foo.ts',
      range: { startLine: 1, endLine: 30 },
      boundedContext: 'capture',
      intent: 'handles foo',
      layer: 'service',
      confidence: 0.9,
      risks: [{ type: 'concurrency', desc: 'shared state' }],
      methods: [
        { name: 'doThing', signature: '(x)', line: 5, risks: ['concurrency'], readState: 'read' },
        { name: 'helper', signature: '()', line: 20, risks: [] },
      ],
      readingPriority: 1,
      readState: 'read',
      verification: 'partial',
      verificationDetails: {
        rangeAdjusted: false,
        droppedCalls: ['Bar.gone'],
        droppedExternalCalls: [],
      },
    },
  },
  edges: [
    { from: 'Foo', to: 'Bar', kind: 'calls', verified: true },
    { from: 'Foo', to: 'ext:lodash', kind: 'external_calls', verified: true },
  ],
  externalDeps: [{ name: 'lodash', kind: 'package' }],
};

// Extend the shared fixture with Bar so edges from Foo→Bar resolve cleanly;
// the original fixture only had Foo, which would now be filtered out by the
// dangling-edge defense added in graph-adapter.
const G2: CodeMapGraph = {
  ...GRAPH,
  nodes: {
    ...GRAPH.nodes,
    Bar: {
      id: 'Bar',
      kind: 'class',
      file: 'src/bar.ts',
      range: { startLine: 1, endLine: 10 },
      boundedContext: 'shared',
      intent: 'collaborator',
      confidence: 0.9,
      risks: [],
      methods: [],
      readingPriority: 99,
      readState: 'unread',
      verification: 'verified',
    },
  },
};

describe('adaptGraphForMockup', () => {
  it('maps boundedContext → bc', () => {
    const out = adaptGraphForMockup(GRAPH);
    expect(out.classes[0]!.bc).toBe('capture');
  });

  it('maps method signature → sig and readState → read', () => {
    const out = adaptGraphForMockup(GRAPH);
    const methods = out.classes[0]!.methods;
    expect(methods[0]).toMatchObject({ name: 'doThing', sig: '(x)', read: true });
    expect(methods[1]).toMatchObject({ name: 'helper', sig: '()', read: false });
  });

  it('preserves verification, verificationDetails, risks', () => {
    const out = adaptGraphForMockup(GRAPH);
    const cls = out.classes[0]!;
    expect(cls.verification).toBe('partial');
    expect(cls.verificationDetails?.droppedCalls).toEqual(['Bar.gone']);
    expect(cls.risks[0]).toEqual({ type: 'concurrency', desc: 'shared state' });
  });

  it('defaults missing readingPriority to 99', () => {
    const noPrio: CodeMapGraph = {
      ...GRAPH,
      nodes: { X: { ...GRAPH.nodes.Foo!, id: 'X', readingPriority: undefined } },
    };
    expect(adaptGraphForMockup(noPrio).classes[0]!.readingPriority).toBe(99);
  });

  it('passes through edges and externalDeps unchanged', () => {
    const out = adaptGraphForMockup(G2);
    expect(out.edges).toHaveLength(2);
    expect(out.edges[0]).toEqual({ from: 'Foo', to: 'Bar', kind: 'calls', verified: true });
    expect(out.externalDeps).toEqual([{ name: 'lodash', kind: 'package' }]);
  });

  it('drops dangling edges whose endpoint is not a node or ext: dep', () => {
    // The aggregator now guards against this at source, but if anything
    // ever lets a dangling edge through, cytoscape's "Can not create edge
    // with nonexistent target" error blanks the whole webview. The adapter
    // is the last clean boundary before the data ships to the renderer.
    const graph: CodeMapGraph = {
      ...GRAPH,
      edges: [
        { from: 'Foo', to: 'Bar', kind: 'calls', verified: true },                 // Bar isn't in nodes
        { from: 'Ghost', to: 'Foo', kind: 'calls', verified: false },              // Ghost isn't in nodes
        { from: 'Foo', to: 'ext:notADep', kind: 'external_calls', verified: true },// notADep isn't in externalDeps
        { from: 'Foo', to: 'ext:lodash', kind: 'external_calls', verified: true }, // valid
      ],
    };
    const out = adaptGraphForMockup(graph);
    expect(out.edges).toEqual([
      { from: 'Foo', to: 'ext:lodash', kind: 'external_calls', verified: true },
    ]);
  });

  it('threads chat turns through unchanged', () => {
    const turns = [{ role: 'user' as const, name: 'You', time: '14:00', content: 'hi' }];
    const out = adaptGraphForMockup(GRAPH, turns);
    expect(out.chatTurns).toEqual(turns);
  });

  it('defaults chat turns to []', () => {
    expect(adaptGraphForMockup(GRAPH).chatTurns).toEqual([]);
  });

  it('derives stats from the graph when not given explicitly', () => {
    const out = adaptGraphForMockup(GRAPH);
    expect(out.stats).toEqual({
      verifiedCount: 0,
      partialCount: 1,    // Foo is partial in the fixture
      unverifiedCount: 0,
    });
  });

  it('passes explicit stats through verbatim, including eval', () => {
    const stats = {
      verifiedCount: 10,
      partialCount: 2,
      unverifiedCount: 1,
      filesAnalyzed: 14,
      durationMs: 42300,
      eval: {
        nodes: { precision: 0.93, recall: 0.86, f1: 0.89 },
        edges: { precision: 0.84, recall: 0.77, f1: 0.80 },
      },
    };
    expect(adaptGraphForMockup(GRAPH, [], stats).stats).toBe(stats);
  });

  describe('bc remap onto mockup slots', () => {
    const mkNode = (id: string, bc: string) => ({
      id,
      kind: 'class' as const,
      file: `src/${id}.ts`,
      range: { startLine: 1, endLine: 10 },
      boundedContext: bc,
      intent: '',
      confidence: 0.9,
      risks: [],
      methods: [],
      readingPriority: 1,
      readState: 'unread' as const,
      verification: 'verified' as const,
    });

    it('is a no-op when every bc already matches a mockup slot', () => {
      const g: CodeMapGraph = {
        ...GRAPH,
        nodes: {
          A: mkNode('A', 'host'),
          B: mkNode('B', 'capture'),
          C: mkNode('C', 'shared'),
        },
      };
      const out = adaptGraphForMockup(g);
      expect(out.classes.map(c => [c.id, c.bc])).toEqual([
        ['A', 'host'],
        ['B', 'capture'],
        ['C', 'shared'],
      ]);
      expect(out.meta?.bcLabels).toEqual({
        host: 'Host',
        capture: 'Capture',
        recall: 'Recall',
        shared: 'Shared',
      });
    });

    it('remaps arbitrary bc names onto host/capture/recall/shared slots by frequency', () => {
      const g: CodeMapGraph = {
        ...GRAPH,
        nodes: {
          A: mkNode('A', 'microsoft.agents.ai.azureai'),
          B: mkNode('B', 'microsoft.agents.ai.azureai'),
          C: mkNode('C', 'microsoft.agents.ai.openai'),
          D: mkNode('D', 'microsoft.agents.ai.core'),
        },
      };
      const out = adaptGraphForMockup(g);
      // azureai (2 nodes) → host (most populous)
      expect(out.classes.find(c => c.id === 'A')?.bc).toBe('host');
      expect(out.classes.find(c => c.id === 'B')?.bc).toBe('host');
      // openai vs core both have 1 node → alphabetical tie-break: 'core' < 'openai',
      // so core gets capture (slot 1) and openai gets recall (slot 2).
      expect(out.classes.find(c => c.id === 'D')?.bc).toBe('capture'); // core
      expect(out.classes.find(c => c.id === 'C')?.bc).toBe('recall'); // openai
      // Labels reflect the real bucket names (prettified).
      expect(out.meta?.bcLabels?.host.toLowerCase()).toContain('azureai');
      // Shared falls back since only 3 distinct buckets exist.
      expect(out.meta?.bcLabels?.shared).toBe('Shared');
    });

    it('collapses 5+ distinct bc names into the shared slot with "Other" label', () => {
      const g: CodeMapGraph = {
        ...GRAPH,
        nodes: {
          A: mkNode('A', 'one'),
          B: mkNode('B', 'two'),
          C: mkNode('C', 'three'),
          D: mkNode('D', 'four'),
          E: mkNode('E', 'five'),
        },
      };
      const out = adaptGraphForMockup(g);
      const sharedSlotMembers = out.classes.filter(c => c.bc === 'shared');
      // Top-3 go to host/capture/recall; remaining 2 collapse into shared.
      expect(sharedSlotMembers).toHaveLength(2);
      expect(out.meta?.bcLabels?.shared).toBe('Other');
    });
  });
});

describe('focus-mode metadata (Slice 1)', () => {
  // Minimal CodeNode factory; tests below opt-in to isEntry by spreading.
  const mkNode = (
    id: string,
    overrides: Partial<{ isEntry: boolean; methods: { name: string; signature: string; line: number; risks: string[]; intent?: string }[] }> = {},
  ) => ({
    id,
    kind: 'class' as const,
    file: `src/${id}.ts`,
    range: { startLine: 1, endLine: 10 },
    boundedContext: 'host',
    intent: '',
    confidence: 0.9,
    risks: [],
    methods: overrides.methods ?? [],
    readingPriority: 1,
    readState: 'unread' as const,
    verification: 'verified' as const,
    isEntry: overrides.isEntry,
  });

  it('emits no entries and marks nothing shared when no class is isEntry', () => {
    const g: CodeMapGraph = {
      rootRequest: '',
      scope: '',
      nodes: {
        A: mkNode('A', { methods: [{ name: 'm', signature: '()', line: 1, risks: [] }] }),
        B: mkNode('B'),
      },
      edges: [{ from: 'A', to: 'B', kind: 'calls', verified: true }],
      externalDeps: [],
    };
    const out = adaptGraphForMockup(g);
    expect(out.entries).toEqual([]);
    expect(out.classes.every(c => c.isShared === undefined)).toBe(true);
  });

  it('emits one entry per method on every isEntry: true class', () => {
    const g: CodeMapGraph = {
      rootRequest: '',
      scope: '',
      nodes: {
        Endpoint: mkNode('Endpoint', {
          isEntry: true,
          methods: [
            { name: 'getOne', signature: '(id)', line: 1, risks: [], intent: 'fetch a single record' },
            { name: 'listAll', signature: '()', line: 5, risks: ['security'] },
          ],
        }),
        Helper: mkNode('Helper'),
      },
      edges: [],
      externalDeps: [],
    };
    const out = adaptGraphForMockup(g);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toEqual({
      classId: 'Endpoint',
      methodName: 'getOne',
      signature: '(id)',
      intent: 'fetch a single record',
      risks: [],
      reachableClassIds: [],
    });
    expect(out.entries[1]!.methodName).toBe('listAll');
    expect(out.entries[1]!.risks).toEqual(['security']);
    expect(out.entries[1]!.intent).toBe(''); // missing → ''
  });

  it('walks class-to-class calls edges (BFS reachability)', () => {
    // A → B → C → D, entry on A.
    const g: CodeMapGraph = {
      rootRequest: '',
      scope: '',
      nodes: {
        A: mkNode('A', { isEntry: true, methods: [{ name: 'run', signature: '()', line: 1, risks: [] }] }),
        B: mkNode('B'),
        C: mkNode('C'),
        D: mkNode('D'),
      },
      edges: [
        { from: 'A', to: 'B', kind: 'calls', verified: true },
        { from: 'B', to: 'C', kind: 'calls', verified: true },
        { from: 'C', to: 'D', kind: 'calls', verified: true },
      ],
      externalDeps: [],
    };
    const reachable = adaptGraphForMockup(g).entries[0]!.reachableClassIds.sort();
    expect(reachable).toEqual(['B', 'C', 'D']);
  });

  it('terminates on cycles', () => {
    // A → B → A (cycle).
    const g: CodeMapGraph = {
      rootRequest: '',
      scope: '',
      nodes: {
        A: mkNode('A', { isEntry: true, methods: [{ name: 'run', signature: '()', line: 1, risks: [] }] }),
        B: mkNode('B'),
      },
      edges: [
        { from: 'A', to: 'B', kind: 'calls', verified: true },
        { from: 'B', to: 'A', kind: 'calls', verified: true },
      ],
      externalDeps: [],
    };
    const out = adaptGraphForMockup(g);
    // BFS skips the start node — reachable is just {B}, not {A,B}.
    expect(out.entries[0]!.reachableClassIds).toEqual(['B']);
  });

  it('never traverses external_calls edges', () => {
    const g: CodeMapGraph = {
      rootRequest: '',
      scope: '',
      nodes: {
        A: mkNode('A', { isEntry: true, methods: [{ name: 'run', signature: '()', line: 1, risks: [] }] }),
      },
      edges: [
        { from: 'A', to: 'ext:lodash', kind: 'external_calls', verified: true },
      ],
      externalDeps: [{ name: 'lodash', kind: 'package' }],
    };
    expect(adaptGraphForMockup(g).entries[0]!.reachableClassIds).toEqual([]);
  });

  it('marks a class shared when reached by ≥30% of entries (boundary inclusive)', () => {
    // 10 entry methods total. Shared reached by exactly 3 of them → 30% → shared.
    // Borderline reached by 2 → 20% → not shared.
    const entryClass = (id: string, reachTargets: string[]) => ({
      ...mkNode(id, { isEntry: true, methods: [{ name: 'run', signature: '()', line: 1, risks: [] }] }),
    });
    const nodes: Record<string, ReturnType<typeof mkNode>> = {
      Shared: mkNode('Shared'),
      Borderline: mkNode('Borderline'),
    };
    const edges: { from: string; to: string; kind: 'calls'; verified: boolean }[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `E${i}`;
      nodes[id] = entryClass(id, []);
      if (i < 3) edges.push({ from: id, to: 'Shared', kind: 'calls', verified: true });
      if (i < 2) edges.push({ from: id, to: 'Borderline', kind: 'calls', verified: true });
    }
    const g: CodeMapGraph = { rootRequest: '', scope: '', nodes, edges, externalDeps: [] };
    const out = adaptGraphForMockup(g);
    expect(out.classes.find(c => c.id === 'Shared')!.isShared).toBe(true);
    expect(out.classes.find(c => c.id === 'Borderline')!.isShared).toBeUndefined();
  });

  it('never marks an entry class as shared, even if reached by every entry', () => {
    // EntryA → EntryB → EntryC; all three are isEntry. EntryB and EntryC
    // would qualify by reachability alone (≥30%) but must stay unmarked.
    const g: CodeMapGraph = {
      rootRequest: '',
      scope: '',
      nodes: {
        A: mkNode('A', { isEntry: true, methods: [{ name: 'run', signature: '()', line: 1, risks: [] }] }),
        B: mkNode('B', { isEntry: true, methods: [{ name: 'run', signature: '()', line: 1, risks: [] }] }),
        C: mkNode('C', { isEntry: true, methods: [{ name: 'run', signature: '()', line: 1, risks: [] }] }),
        NonEntry: mkNode('NonEntry'),
      },
      edges: [
        { from: 'A', to: 'B', kind: 'calls', verified: true },
        { from: 'B', to: 'C', kind: 'calls', verified: true },
        { from: 'A', to: 'NonEntry', kind: 'calls', verified: true },
        { from: 'B', to: 'NonEntry', kind: 'calls', verified: true },
        { from: 'C', to: 'NonEntry', kind: 'calls', verified: true },
      ],
      externalDeps: [],
    };
    const out = adaptGraphForMockup(g);
    expect(out.classes.find(c => c.id === 'A')!.isShared).toBeUndefined();
    expect(out.classes.find(c => c.id === 'B')!.isShared).toBeUndefined();
    expect(out.classes.find(c => c.id === 'C')!.isShared).toBeUndefined();
    // NonEntry is reached by every entry → definitely shared.
    expect(out.classes.find(c => c.id === 'NonEntry')!.isShared).toBe(true);
  });

  it('produces per-method reachable sets seeded from method.calls', () => {
    // Two methods on an entry class with distinct `calls` should each get
    // their own reachable set, narrowed to what that method actually reaches
    // (plus transitive BFS through class-level adjacency).
    const g: CodeMapGraph = {
      rootRequest: '',
      scope: '',
      nodes: {
        E: mkNode('E', {
          isEntry: true,
          methods: [
            { name: 'a', signature: '()', line: 1, risks: [], calls: ['T1'] },
            { name: 'b', signature: '()', line: 2, risks: [], calls: ['T2'] },
          ],
        }),
        T1: mkNode('T1'),
        T2: mkNode('T2'),
      },
      edges: [
        { from: 'E', to: 'T1', kind: 'calls', verified: true },
        { from: 'E', to: 'T2', kind: 'calls', verified: true },
      ],
      externalDeps: [],
    };
    const out = adaptGraphForMockup(g);
    expect(out.entries).toHaveLength(2);
    const reachA = out.entries[0]!.reachableClassIds;
    const reachB = out.entries[1]!.reachableClassIds;
    expect(reachA).toEqual(['T1']);
    expect(reachB).toEqual(['T2']);
  });

  it('falls back to class-level reach when a method has no calls', () => {
    // Methods with empty/missing `calls` use the class-level adjacency BFS
    // so analyzer outputs that skip per-method attribution still get a
    // sensible focus subgraph.
    const g: CodeMapGraph = {
      rootRequest: '',
      scope: '',
      nodes: {
        E: mkNode('E', {
          isEntry: true,
          methods: [
            { name: 'a', signature: '()', line: 1, risks: [] },
            { name: 'b', signature: '()', line: 2, risks: [] },
          ],
        }),
        T: mkNode('T'),
      },
      edges: [{ from: 'E', to: 'T', kind: 'calls', verified: true }],
      externalDeps: [],
    };
    const out = adaptGraphForMockup(g);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]!.reachableClassIds).toEqual(['T']);
    expect(out.entries[1]!.reachableClassIds).toEqual(['T']);
  });
});
