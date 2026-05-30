// Phase 3.4 -- v2 score.ts coverage.

import { describe, it, expect } from 'vitest';
import { scoreGraph, type GoldenSample } from '../../../src/eval/score';
import type {
  ClassNode,
  CodeMapGraph,
  MethodEdge,
  MethodNode,
} from '../../../src/shared/types';

function cls(overrides: Partial<ClassNode> & { id: string; file: string }): ClassNode {
  return {
    kind: 'class',
    boundedContext: 'core',
    range: { startLine: 1, endLine: 10 },
    intent: 't',
    confidence: 0.9,
    risks: [],
    methodIds: [],
    verification: 'verified',
    ...overrides,
  };
}

function mth(overrides: Partial<MethodNode> & { id: string; ownerClassId: string; name: string }): MethodNode {
  return {
    signature: '()',
    line: 5,
    risks: [],
    verification: 'verified',
    ...overrides,
  };
}

function graph(overrides: Partial<CodeMapGraph> = {}): CodeMapGraph {
  return {
    schemaVersion: 2,
    rootRequest: '@codemap',
    scope: 'workspace',
    boundedContexts: ['core'],
    classes: {},
    methods: {},
    externalDeps: {},
    methodEdges: [],
    classEdges: [],
    entryMethodIds: [],
    readingOrder: [],
    ...overrides,
  };
}

// =========================================================================

describe('scoreGraph -- class tier', () => {
  it('returns 0 across the board when both sides are empty', () => {
    const sc = scoreGraph(graph(), { name: 'g' });
    expect(sc.classes.precision).toBe(0);
    expect(sc.classes.recall).toBe(0);
    expect(sc.classes.f1).toBe(0);
    expect(sc.classEdges.f1).toBe(0);
  });

  it('scores a perfect match as F1=1', () => {
    const g = graph({
      classes: {
        A: cls({ id: 'A', file: 'a.cs' }),
        B: cls({ id: 'B', file: 'b.cs' }),
      },
      classEdges: [{ source: 'A', target: 'B', kind: 'calls', multiplicity: 1, verified: true }],
    });
    const golden: GoldenSample = {
      name: 'g',
      classNodes: ['A', 'B'],
      classEdges: [{ from: 'A', to: 'B' }],
    };
    const sc = scoreGraph(g, golden);
    expect(sc.classes.f1).toBe(1);
    expect(sc.classEdges.f1).toBe(1);
    expect(sc.diff.classes.missingNodes).toEqual([]);
    expect(sc.diff.classes.extraNodes).toEqual([]);
  });

  it('accepts legacy nodes/edges field names', () => {
    const g = graph({
      classes: { A: cls({ id: 'A', file: 'a.cs' }) },
      classEdges: [],
    });
    const golden: GoldenSample = { name: 'g', nodes: ['A'], edges: [] };
    const sc = scoreGraph(g, golden);
    expect(sc.classes.f1).toBe(1);
  });

  it('reports asymmetric precision and recall when sets differ', () => {
    const g = graph({
      classes: {
        A: cls({ id: 'A', file: 'a.cs' }),
        B: cls({ id: 'B', file: 'b.cs' }),
        C: cls({ id: 'C', file: 'c.cs' }),
      },
    });
    const sc = scoreGraph(g, { name: 'g', classNodes: ['A', 'B', 'X', 'Y'] });
    expect(sc.classes.precision).toBeCloseTo(2 / 3, 5);
    expect(sc.classes.recall).toBeCloseTo(2 / 4, 5);
    expect(sc.diff.classes.missingNodes.sort()).toEqual(['X', 'Y']);
    expect(sc.diff.classes.extraNodes).toEqual(['C']);
  });
});

// =========================================================================

describe('scoreGraph -- scoping', () => {
  it('filters actual class nodes by scopeFiles prefix', () => {
    const g = graph({
      classes: {
        InCapture: cls({ id: 'InCapture', file: 'apps/api/src/Capture/Foo.cs' }),
        OutOfScope: cls({ id: 'OutOfScope', file: 'apps/api/src/Recall/Bar.cs' }),
      },
    });
    const sc = scoreGraph(g, {
      name: 'g',
      scopeFiles: ['apps/api/src/Capture'],
      classNodes: ['InCapture'],
    });
    expect(sc.classes.f1).toBe(1);
    expect(sc.diff.classes.extraNodes).not.toContain('OutOfScope');
  });

  it('does not penalise outbound edges whose source is in scope but target leaves it', () => {
    const g = graph({
      classes: {
        A: cls({ id: 'A', file: 'apps/api/src/Capture/A.cs' }),
        B: cls({ id: 'B', file: 'apps/api/src/Recall/B.cs' }),
      },
      classEdges: [{ source: 'A', target: 'B', kind: 'calls', multiplicity: 1, verified: true }],
    });
    const sc = scoreGraph(g, {
      name: 'g',
      scopeFiles: ['apps/api/src/Capture'],
      classNodes: ['A'],
      classEdges: [{ from: 'A', to: 'B' }],
    });
    expect(sc.classEdges.f1).toBe(1);
  });

  it('drops edges whose source is out of scope', () => {
    const g = graph({
      classes: { A: cls({ id: 'A', file: 'src/Recall/A.cs' }) },
      classEdges: [{ source: 'A', target: 'B', kind: 'calls', multiplicity: 1, verified: true }],
    });
    const sc = scoreGraph(g, {
      name: 'g',
      scopeFiles: ['src/Capture'],
      classNodes: [],
      classEdges: [],
    });
    expect(sc.classEdges.precision).toBe(0);
    expect(sc.classEdges.recall).toBe(0);
  });
});

// =========================================================================

describe('scoreGraph -- external canonicalisation', () => {
  it('collapses ext:Foo onto an in-graph node id Foo', () => {
    const g = graph({
      classes: {
        Caller: cls({ id: 'Caller', file: 'a.cs' }),
        AssemblyMarker: cls({ id: 'AssemblyMarker', file: 'b.cs' }),
      },
      classEdges: [
        { source: 'Caller', target: 'AssemblyMarker', kind: 'calls', multiplicity: 1, verified: true },
      ],
    });
    const sc = scoreGraph(g, {
      name: 'g',
      classNodes: ['Caller', 'AssemblyMarker'],
      classEdges: [{ from: 'Caller', to: 'ext:AssemblyMarker' }],
    });
    expect(sc.classEdges.f1).toBe(1);
  });

  it('aliases bare ext:X with ext:Ns.X', () => {
    const g = graph({
      classes: { Caller: cls({ id: 'Caller', file: 'a.cs' }) },
      classEdges: [
        { source: 'Caller', target: 'ext:Marker', kind: 'external_calls', multiplicity: 1, verified: true },
      ],
    });
    const sc = scoreGraph(g, {
      name: 'g',
      classNodes: ['Caller'],
      classEdges: [{ from: 'Caller', to: 'ext:Lumen.Capture.Marker' }],
    });
    expect(sc.classEdges.f1).toBe(1);
  });

  it('keeps two FQNs with the same final segment apart when no bare form exists', () => {
    const g = graph({
      classes: { Caller: cls({ id: 'Caller', file: 'a.cs' }) },
      classEdges: [
        { source: 'Caller', target: 'ext:Foo.Marker', kind: 'external_calls', multiplicity: 1, verified: true },
      ],
    });
    const sc = scoreGraph(g, {
      name: 'g',
      classNodes: ['Caller'],
      classEdges: [{ from: 'Caller', to: 'ext:Bar.Marker' }],
    });
    expect(sc.classEdges.f1).toBe(0);
  });
});

// =========================================================================

describe('scoreGraph -- ignoreEdgeToPrefixes', () => {
  it('drops both actual and golden edges that match the prefix', () => {
    const g = graph({
      classes: { Caller: cls({ id: 'Caller', file: 'a.cs' }) },
      classEdges: [
        { source: 'Caller', target: 'ext:System.IO.File', kind: 'external_calls', multiplicity: 1, verified: true },
        { source: 'Caller', target: 'ext:OpenAI', kind: 'external_calls', multiplicity: 1, verified: true },
      ],
    });
    const sc = scoreGraph(g, {
      name: 'g',
      classNodes: ['Caller'],
      classEdges: [{ from: 'Caller', to: 'ext:OpenAI' }],
      ignoreEdgeToPrefixes: ['ext:System.'],
    });
    expect(sc.classEdges.f1).toBe(1);
    expect(sc.diff.classes.extraEdges).toEqual([]);
  });
});

// =========================================================================

describe('scoreGraph -- method tier (opt-in)', () => {
  it('skips method tier when golden does not declare methodNodes / methodEdges', () => {
    const g = graph();
    const sc = scoreGraph(g, { name: 'g', classNodes: [] });
    expect(sc.methods).toBeUndefined();
    expect(sc.methodEdges).toBeUndefined();
    expect(sc.diff.methods).toBeUndefined();
  });

  it('scores methods and method edges when declared', () => {
    const methods: Record<string, MethodNode> = {
      'A.do': mth({ id: 'A.do', ownerClassId: 'A', name: 'do' }),
      'A.skip': mth({ id: 'A.skip', ownerClassId: 'A', name: 'skip' }),
      'B.run': mth({ id: 'B.run', ownerClassId: 'B', name: 'run' }),
    };
    const methodEdges: MethodEdge[] = [
      { id: 'e0', source: 'A.do', target: 'B.run', kind: 'calls', verified: true },
    ];
    const g = graph({
      classes: {
        A: cls({ id: 'A', file: 'a.cs', methodIds: ['A.do', 'A.skip'] }),
        B: cls({ id: 'B', file: 'b.cs', methodIds: ['B.run'] }),
      },
      methods,
      methodEdges,
      classEdges: [{ source: 'A', target: 'B', kind: 'calls', multiplicity: 1, verified: true }],
    });
    const sc = scoreGraph(g, {
      name: 'g',
      classNodes: ['A', 'B'],
      classEdges: [{ from: 'A', to: 'B' }],
      methodNodes: ['A.do', 'B.run'],
      methodEdges: [{ from: 'A.do', to: 'B.run' }],
    });
    expect(sc.methods!.recall).toBe(1);
    expect(sc.methods!.precision).toBeCloseTo(2 / 3, 5);
    expect(sc.methodEdges!.f1).toBe(1);
    expect(sc.diff.methods!.extraNodes).toEqual(['A.skip']);
  });

  it('filters method ids by their owning class scope', () => {
    const methods: Record<string, MethodNode> = {
      'InScope.run': mth({ id: 'InScope.run', ownerClassId: 'InScope', name: 'run' }),
      'OutOfScope.run': mth({ id: 'OutOfScope.run', ownerClassId: 'OutOfScope', name: 'run' }),
    };
    const g = graph({
      classes: {
        InScope: cls({ id: 'InScope', file: 'src/Capture/A.cs', methodIds: ['InScope.run'] }),
        OutOfScope: cls({ id: 'OutOfScope', file: 'src/Recall/B.cs', methodIds: ['OutOfScope.run'] }),
      },
      methods,
    });
    const sc = scoreGraph(g, {
      name: 'g',
      scopeFiles: ['src/Capture'],
      classNodes: ['InScope'],
      methodNodes: ['InScope.run'],
    });
    expect(sc.methods!.f1).toBe(1);
    expect(sc.diff.methods!.extraNodes).not.toContain('OutOfScope.run');
  });
});
