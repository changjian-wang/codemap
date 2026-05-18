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
});
