// Phase 3.3a -- aggregator unit tests.
//
// All inputs are constructed by hand (no real LLM, no real calibrator) so
// the assertions pin the v2 graph shape contract: target-resolution
// priority, class-edge derivation, verification rollup, external dep
// dedup, entryMethodIds, readingOrder.

import { describe, expect, it } from 'vitest';
import { aggregate } from '../../../src/orchestrator/aggregator';
import type { Callee } from '../../../src/shared/calibrator-protocol';
import type { ClassNode, MethodNode } from '../../../src/shared/types';
import type { AnalyzeResult } from '../../../src/orchestrator/analyze-file';

function cls(overrides: Partial<ClassNode> & { id: string; file: string; methodIds: string[] }): ClassNode {
  return {
    kind: 'class',
    boundedContext: '',
    range: { startLine: 1, endLine: 10 },
    intent: '',
    confidence: 0.9,
    risks: [],
    verification: 'unverified',
    ...overrides,
  };
}

function mth(overrides: Partial<MethodNode> & { id: string; ownerClassId: string; name: string }): MethodNode {
  return {
    signature: '()',
    line: 1,
    risks: [],
    verification: 'unverified',
    ...overrides,
  };
}

function analyze(
  filePath: string,
  classes: ClassNode[],
  methods: MethodNode[],
  llmCalls: Record<string, string[]> = {},
): AnalyzeResult {
  return { filePath, classes, methods, llmCalls, rawResponse: '', parseErrors: [] };
}

function callee(overrides: Partial<Callee> & { containingType: string; methodName: string }): Callee {
  return {
    displayName: `${overrides.containingType}.${overrides.methodName}`,
    fullyQualifiedName: `${overrides.containingType}.${overrides.methodName}`,
    kind: 'method',
    isExternal: false,
    isExtension: false,
    filePath: null,
    line: null,
    invocationLine: 1,
    ...overrides,
  };
}

describe('aggregate', () => {
  it('returns an empty graph when no analyses are provided', () => {
    const { graph, warnings } = aggregate({
      rootRequest: 'r',
      scope: 's',
      analyses: [],
      callees: new Map(),
    });
    expect(graph.schemaVersion).toBe(2);
    expect(graph.classes).toEqual({});
    expect(graph.methods).toEqual({});
    expect(graph.methodEdges).toEqual([]);
    expect(graph.classEdges).toEqual([]);
    expect(graph.boundedContexts).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('merges classes and methods from multiple files', () => {
    const a = analyze(
      'apps/api/src/Lumen.Modules.Capture/A.cs',
      [cls({ id: 'A', file: 'apps/api/src/Lumen.Modules.Capture/A.cs', boundedContext: 'capture', methodIds: ['A.Do'] })],
      [mth({ id: 'A.Do', ownerClassId: 'A', name: 'Do' })],
    );
    const b = analyze(
      'apps/api/src/Lumen.Modules.Recall/B.cs',
      [cls({ id: 'B', file: 'apps/api/src/Lumen.Modules.Recall/B.cs', boundedContext: 'recall', methodIds: ['B.Go'] })],
      [mth({ id: 'B.Go', ownerClassId: 'B', name: 'Go' })],
    );
    const { graph } = aggregate({ rootRequest: 'r', scope: 's', analyses: [a, b], callees: new Map() });
    expect(Object.keys(graph.classes).sort()).toEqual(['A', 'B']);
    expect(Object.keys(graph.methods).sort()).toEqual(['A.Do', 'B.Go']);
  });

  it('warns on duplicate class ids and keeps the first occurrence', () => {
    const dupA = cls({ id: 'A', file: 'first/A.cs', methodIds: [] });
    const dupB = cls({ id: 'A', file: 'second/A.cs', methodIds: [] });
    const { graph, warnings } = aggregate({
      rootRequest: 'r',
      scope: 's',
      analyses: [analyze('first/A.cs', [dupA], []), analyze('second/A.cs', [dupB], [])],
      callees: new Map(),
    });
    expect(graph.classes.A!.file).toBe('first/A.cs');
    expect(warnings.some((w) => w.includes("duplicate class id 'A'"))).toBe(true);
  });

  it('resolves in-graph method targets and marks edges verified', () => {
    const a = analyze('a.cs',
      [cls({ id: 'A', file: 'a.cs', methodIds: ['A.Do'] })],
      [mth({ id: 'A.Do', ownerClassId: 'A', name: 'Do' })]);
    const b = analyze('b.cs',
      [cls({ id: 'B', file: 'b.cs', methodIds: ['B.Run'] })],
      [mth({ id: 'B.Run', ownerClassId: 'B', name: 'Run' })]);
    const callees = new Map<string, Callee[]>([
      ['A.Do', [callee({ containingType: 'B', methodName: 'Run' })]],
      ['B.Run', []],
    ]);
    const { graph } = aggregate({ rootRequest: 'r', scope: 's', analyses: [a, b], callees });
    expect(graph.methodEdges).toEqual([
      { id: 'e0', source: 'A.Do', target: 'B.Run', kind: 'calls', verified: true },
    ]);
  });

  it('falls back to class id when the callee class is in-graph but the method is not', () => {
    const a = analyze('a.cs',
      [cls({ id: 'A', file: 'a.cs', methodIds: ['A.Do'] })],
      [mth({ id: 'A.Do', ownerClassId: 'A', name: 'Do' })]);
    const b = analyze('b.cs',
      [cls({ id: 'B', file: 'b.cs', methodIds: [] })],
      []);
    const callees = new Map<string, Callee[]>([
      ['A.Do', [callee({ containingType: 'B', methodName: 'UnseenMethod' })]],
    ]);
    const { graph } = aggregate({ rootRequest: 'r', scope: 's', analyses: [a, b], callees });
    expect(graph.methodEdges).toEqual([
      { id: 'e0', source: 'A.Do', target: 'B', kind: 'calls', verified: true },
    ]);
  });

  it('emits ext: target and registers externalDeps for unknown callees', () => {
    const a = analyze('a.cs',
      [cls({ id: 'A', file: 'a.cs', methodIds: ['A.Do'] })],
      [mth({ id: 'A.Do', ownerClassId: 'A', name: 'Do' })]);
    const callees = new Map<string, Callee[]>([
      ['A.Do', [
        callee({ containingType: 'OpenAI', methodName: 'Send', isExternal: true }),
        callee({ containingType: 'GroundedAskPromptsV2', methodName: 'Build' }),
      ]],
    ]);
    const { graph } = aggregate({ rootRequest: 'r', scope: 's', analyses: [a], callees });
    expect(graph.methodEdges).toEqual([
      { id: 'e0', source: 'A.Do', target: 'ext:OpenAI', kind: 'external_calls', verified: true },
      { id: 'e1', source: 'A.Do', target: 'ext:GroundedAskPromptsV2', kind: 'external_calls', verified: false },
    ]);
    expect(graph.externalDeps['ext:OpenAI']).toEqual({ id: 'ext:OpenAI', name: 'OpenAI', kind: 'package' });
    expect(graph.externalDeps['ext:GroundedAskPromptsV2']).toBeDefined();
  });

  it('skips constructors, local functions, and unknown callees', () => {
    const a = analyze('a.cs',
      [cls({ id: 'A', file: 'a.cs', methodIds: ['A.Do'] })],
      [mth({ id: 'A.Do', ownerClassId: 'A', name: 'Do' })]);
    const callees = new Map<string, Callee[]>([
      ['A.Do', [
        callee({ containingType: 'B', methodName: 'ctor', kind: 'constructor' }),
        callee({ containingType: '', methodName: 'helper', kind: 'localFunction' }),
        callee({ containingType: 'X', methodName: 'Y', kind: 'unknown' }),
      ]],
    ]);
    const { graph } = aggregate({ rootRequest: 'r', scope: 's', analyses: [a], callees });
    expect(graph.methodEdges).toEqual([]);
    expect(graph.externalDeps).toEqual({});
  });

  it('deduplicates identical edges and bare class names from FQN containingType', () => {
    const a = analyze('a.cs',
      [cls({ id: 'A', file: 'a.cs', methodIds: ['A.Do'] })],
      [mth({ id: 'A.Do', ownerClassId: 'A', name: 'Do' })]);
    const b = analyze('b.cs',
      [cls({ id: 'B', file: 'b.cs', methodIds: ['B.Run'] })],
      [mth({ id: 'B.Run', ownerClassId: 'B', name: 'Run' })]);
    const callees = new Map<string, Callee[]>([
      ['A.Do', [
        callee({ containingType: 'Lumen.Modules.X.B', methodName: 'Run' }),
        callee({ containingType: 'Other.Module.B', methodName: 'Run' }),
      ]],
    ]);
    const { graph } = aggregate({ rootRequest: 'r', scope: 's', analyses: [a, b], callees });
    expect(graph.methodEdges).toHaveLength(1);
    expect(graph.methodEdges[0]!.target).toBe('B.Run');
  });

  it('upgrades method verification to verified when calibrator answered with all in-graph targets', () => {
    const a = analyze('a.cs',
      [cls({ id: 'A', file: 'a.cs', methodIds: ['A.Do', 'A.NoCalls', 'A.Silent'] })],
      [
        mth({ id: 'A.Do', ownerClassId: 'A', name: 'Do' }),
        mth({ id: 'A.NoCalls', ownerClassId: 'A', name: 'NoCalls' }),
        mth({ id: 'A.Silent', ownerClassId: 'A', name: 'Silent' }),
      ]);
    const b = analyze('b.cs',
      [cls({ id: 'B', file: 'b.cs', methodIds: ['B.Run'] })],
      [mth({ id: 'B.Run', ownerClassId: 'B', name: 'Run' })]);
    const callees = new Map<string, Callee[]>([
      ['A.Do', [callee({ containingType: 'B', methodName: 'Run' })]],
      ['A.NoCalls', []],
      ['B.Run', []],
    ]);
    const { graph } = aggregate({ rootRequest: 'r', scope: 's', analyses: [a, b], callees });
    expect(graph.methods['A.Do']!.verification).toBe('verified');
    expect(graph.methods['A.NoCalls']!.verification).toBe('verified');
    expect(graph.methods['A.Silent']!.verification).toBe('unverified');
    expect(graph.classes.A!.verification).toBe('partial');
  });

  it('marks methods partial when at least one resolved callee landed on an ext: target with isExternal=false', () => {
    const a = analyze('a.cs',
      [cls({ id: 'A', file: 'a.cs', methodIds: ['A.Do'] })],
      [mth({ id: 'A.Do', ownerClassId: 'A', name: 'Do' })]);
    const callees = new Map<string, Callee[]>([
      ['A.Do', [
        callee({ containingType: 'GroundedAskPromptsV2', methodName: 'Build' }),
      ]],
    ]);
    const { graph } = aggregate({ rootRequest: 'r', scope: 's', analyses: [a], callees });
    expect(graph.methodEdges[0]!.verified).toBe(false);
    expect(graph.methods['A.Do']!.verification).toBe('partial');
    expect(graph.classes.A!.verification).toBe('partial');
    expect(graph.classes.A!.verificationDetails?.droppedTargets).toContain('GroundedAskPromptsV2');
  });

  it('derives classEdges from methodEdges with multiplicity and OR-ed verified', () => {
    const a = analyze('a.cs',
      [cls({ id: 'A', file: 'a.cs', methodIds: ['A.One', 'A.Two'] })],
      [
        mth({ id: 'A.One', ownerClassId: 'A', name: 'One' }),
        mth({ id: 'A.Two', ownerClassId: 'A', name: 'Two' }),
      ]);
    const b = analyze('b.cs',
      [cls({ id: 'B', file: 'b.cs', methodIds: ['B.Run', 'B.Hidden'] })],
      [
        mth({ id: 'B.Run', ownerClassId: 'B', name: 'Run' }),
        mth({ id: 'B.Hidden', ownerClassId: 'B', name: 'Hidden' }),
      ]);
    const callees = new Map<string, Callee[]>([
      ['A.One', [callee({ containingType: 'B', methodName: 'Run' })]],
      ['A.Two', [callee({ containingType: 'B', methodName: 'Run' }), callee({ containingType: 'B', methodName: 'Phantom' })]],
    ]);
    const { graph } = aggregate({ rootRequest: 'r', scope: 's', analyses: [a, b], callees });
    // Two method edges into B.Run + one fallback to B class = 3 edges total
    expect(graph.methodEdges).toHaveLength(3);
    const ab = graph.classEdges.filter((e) => e.source === 'A' && e.target === 'B');
    expect(ab).toHaveLength(1);
    expect(ab[0]!.multiplicity).toBe(3);
    expect(ab[0]!.verified).toBe(true);
  });

  it('collects entryMethodIds from isEntry classes and builds readingOrder entries-first', () => {
    const a = analyze('a.cs',
      [cls({ id: 'Entry', file: 'a.cs', isEntry: true, entryKind: 'http_endpoint', methodIds: ['Entry.Handle'] })],
      [mth({ id: 'Entry.Handle', ownerClassId: 'Entry', name: 'Handle' })]);
    const b = analyze('b.cs',
      [cls({ id: 'Helper', file: 'b.cs', methodIds: ['Helper.Tick', 'Helper.Process'] })],
      [
        mth({ id: 'Helper.Tick', ownerClassId: 'Helper', name: 'Tick' }),
        mth({ id: 'Helper.Process', ownerClassId: 'Helper', name: 'Process' }),
      ]);
    const { graph } = aggregate({ rootRequest: 'r', scope: 's', analyses: [a, b], callees: new Map() });
    expect(graph.entryMethodIds).toEqual(['Entry.Handle']);
    expect(graph.readingOrder).toEqual(['Entry.Handle', 'Helper.Tick', 'Helper.Process']);
  });

  it('orders boundedContexts by frequency desc with "shared" last', () => {
    const recall1 = cls({ id: 'R1', file: 'x.cs', boundedContext: 'recall', methodIds: [] });
    const recall2 = cls({ id: 'R2', file: 'x.cs', boundedContext: 'recall', methodIds: [] });
    const capture1 = cls({ id: 'C1', file: 'x.cs', boundedContext: 'capture', methodIds: [] });
    const shared1 = cls({ id: 'S1', file: 'x.cs', boundedContext: 'shared', methodIds: [] });
    const shared2 = cls({ id: 'S2', file: 'x.cs', boundedContext: 'shared', methodIds: [] });
    const shared3 = cls({ id: 'S3', file: 'x.cs', boundedContext: 'shared', methodIds: [] });
    const a = analyze('x.cs', [recall1, recall2, capture1, shared1, shared2, shared3], []);
    const { graph } = aggregate({ rootRequest: 'r', scope: 's', analyses: [a], callees: new Map() });
    expect(graph.boundedContexts).toEqual(['recall', 'capture', 'shared']);
  });

  // -----------------------------------------------------------------------
  //   LLM-calls fallback (calibrator absent / partial)
  // -----------------------------------------------------------------------

  it('emits verified=false edges from llmCalls when calibrator did not answer for a method', () => {
    const A = cls({ id: 'A', file: 'a.cs', methodIds: ['A.run'] });
    const B = cls({ id: 'B', file: 'b.cs', methodIds: ['B.handle'] });
    const aRun = mth({ id: 'A.run', ownerClassId: 'A', name: 'run' });
    const bHandle = mth({ id: 'B.handle', ownerClassId: 'B', name: 'handle' });
    const ana = analyze('a.cs', [A, B], [aRun, bHandle], {
      'A.run': ['B.handle', 'C', 'ExternalLib.Foo'],
    });
    const { graph } = aggregate({
      rootRequest: 'r',
      scope: 's',
      analyses: [ana],
      callees: new Map(),
    });
    // Three edges: in-graph method, ext: (C is not in graph -> ext:C),
    // and ExternalLib.Foo -> class C is not in graph, the lastIndexOf('.')
    // branch tries 'ExternalLib' as a class, also not in graph -> ext:.
    const targets = graph.methodEdges.map((e) => `${e.target}|${e.verified}`).sort();
    expect(targets).toEqual([
      'B.handle|false',
      'ext:C|false',
      'ext:ExternalLib.Foo|false',
    ]);
    expect(graph.externalDeps['ext:C']).toBeDefined();
    expect(graph.externalDeps['ext:ExternalLib.Foo']).toBeDefined();
    // The source method has no calibrator data -> verification stays
    // 'unverified' (no upgrade just because the LLM declared calls).
    expect(graph.methods['A.run']!.verification).toBe('unverified');
  });

  it('prefers calibrator data over llmCalls when both are present for the same method', () => {
    const A = cls({ id: 'A', file: 'a.cs', methodIds: ['A.run'] });
    const B = cls({ id: 'B', file: 'b.cs', methodIds: ['B.handle'] });
    const aRun = mth({ id: 'A.run', ownerClassId: 'A', name: 'run' });
    const bHandle = mth({ id: 'B.handle', ownerClassId: 'B', name: 'handle' });
    const ana = analyze('a.cs', [A, B], [aRun, bHandle], {
      'A.run': ['FakeTarget'],
    });
    const callees = new Map<string, Callee[]>([
      [
        'A.run',
        [callee({ containingType: 'B', methodName: 'handle' })],
      ],
    ]);
    const { graph } = aggregate({
      rootRequest: 'r',
      scope: 's',
      analyses: [ana],
      callees,
    });
    expect(graph.methodEdges).toHaveLength(1);
    expect(graph.methodEdges[0]!.target).toBe('B.handle');
    expect(graph.methodEdges[0]!.verified).toBe(true);
    expect(graph.externalDeps['ext:FakeTarget']).toBeUndefined();
  });
});
