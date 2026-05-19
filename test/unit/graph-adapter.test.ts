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
    const out = adaptGraphForMockup(GRAPH);
    expect(out.edges).toHaveLength(2);
    expect(out.edges[0]).toEqual({ from: 'Foo', to: 'Bar', kind: 'calls', verified: true });
    expect(out.externalDeps).toEqual([{ name: 'lodash', kind: 'package' }]);
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
