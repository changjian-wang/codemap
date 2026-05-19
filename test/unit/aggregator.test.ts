import { describe, it, expect } from 'vitest';
import { aggregate } from '../../src/orchestrator/aggregator';
import type { AnalyzeResult } from '../../src/orchestrator/single-file-analyzer';
import type { SymbolProvider, SymbolHit } from '../../src/calibration/symbol-provider';
import type { CodeNode, CodeEdge } from '../../src/shared/types';

const N = (id: string, partial: Partial<CodeNode> = {}): CodeNode => ({
  id, kind: 'class',
  file: `${id}.ts`,
  range: { startLine: 1, endLine: 10 },
  boundedContext: 'shared',
  intent: id,
  confidence: 0.9,
  risks: [],
  methods: [],
  readState: 'unread',
  verification: 'verified',
  ...partial,
});

const E = (from: string, to: string, kind: 'calls' | 'external_calls' = 'calls', verified = true): CodeEdge =>
  ({ from, to, kind, verified });

const R = (file: string, nodes: CodeNode[], edges: CodeEdge[] = []): AnalyzeResult => ({
  file,
  nodes,
  edges,
  parseErrors: [],
});

function makeSymbols(map: Record<string, SymbolHit[]> = {}): SymbolProvider {
  return {
    async symbolsInFile() { return []; },
    async findInWorkspace(name) { return map[name] ?? []; },
  };
}

describe('aggregate', () => {
  it('returns an empty graph when no analyses given', async () => {
    const { graph, warnings } = await aggregate({
      rootRequest: 'test',
      scope: 'workspace',
      analyses: [],
      symbols: makeSymbols(),
    });
    expect(Object.keys(graph.nodes)).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.externalDeps).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('merges nodes from multiple files, first wins, warns on duplicate', async () => {
    const a = R('a.ts', [N('Foo', { file: 'a.ts' })]);
    const b = R('b.ts', [N('Foo', { file: 'b.ts', intent: 'dupe' })]);
    const { graph, warnings } = await aggregate({
      rootRequest: 'test', scope: 'workspace',
      analyses: [a, b], symbols: makeSymbols(),
    });
    expect(graph.nodes.Foo!.file).toBe('a.ts');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/duplicate class id/);
  });

  it('upgrades to a verified duplicate when first occurrence was partial', async () => {
    const a = R('a.ts', [N('Foo', { file: 'a.ts', verification: 'partial' })]);
    const b = R('b.ts', [N('Foo', { file: 'b.ts', verification: 'verified' })]);
    const { graph } = await aggregate({
      rootRequest: '', scope: 'workspace', analyses: [a, b], symbols: makeSymbols(),
    });
    expect(graph.nodes.Foo!.verification).toBe('verified');
    expect(graph.nodes.Foo!.file).toBe('b.ts');
  });

  it('keeps in-graph calls edges as-is', async () => {
    const a = R('a.ts', [N('Foo'), N('Bar')], [E('Foo', 'Bar')]);
    const { graph } = await aggregate({
      rootRequest: '', scope: 'workspace', analyses: [a], symbols: makeSymbols(),
    });
    expect(graph.edges).toEqual([E('Foo', 'Bar')]);
  });

  it('resolves cross-file calls via workspace symbol lookup', async () => {
    // Calibrator emits verified=false for the cross-file call; aggregator
    // upgrades because Bar is in the merged graph.
    const a = R('a.ts', [N('Foo', { file: 'a.ts' })],
      [{ from: 'Foo', to: 'Bar', kind: 'calls', verified: false }]);
    const b = R('b.ts', [N('Bar', { file: 'b.ts' })]);
    const { graph } = await aggregate({
      rootRequest: '', scope: 'workspace', analyses: [a, b], symbols: makeSymbols(),
    });
    expect(graph.edges).toEqual([E('Foo', 'Bar')]);
  });

  it('marks edge unverified AND downgrades source to partial when target is unknown', async () => {
    // Calibrator emits verified=false for cross-file calls. Aggregator
    // resolves: workspace lookup fails → keep unverified, downgrade source,
    // AND materialize a ghost node so the UI shows a grey dotted box rather
    // than a cytoscape-auto-created blank.
    const a = R('a.ts', [N('Foo', { verification: 'verified' })],
      [{ from: 'Foo', to: 'Ghost', kind: 'calls', verified: false }]);
    const { graph } = await aggregate({
      rootRequest: '', scope: 'workspace', analyses: [a], symbols: makeSymbols(),
    });
    const edge = graph.edges.find(e => e.to === 'Ghost')!;
    expect(edge.verified).toBe(false);
    expect(graph.nodes.Foo!.verification).toBe('partial');
    // Ghost node exists with unverified state.
    expect(graph.nodes.Ghost).toBeDefined();
    expect(graph.nodes.Ghost!.verification).toBe('unverified');
    expect(graph.nodes.Ghost!.verificationDetails?.reason).toBeDefined();
  });

  it('upgrades verified=false cross-file edges when target found in workspace and in-graph', async () => {
    const a = R('a.ts', [N('Foo', { file: 'a.ts' })],
      [{ from: 'Foo', to: 'Bar', kind: 'calls', verified: false }]);
    const b = R('b.ts', [N('Bar', { file: 'b.ts' })]);
    const { graph } = await aggregate({
      rootRequest: '', scope: 'workspace', analyses: [a, b], symbols: makeSymbols(),
    });
    expect(graph.edges).toEqual([{ from: 'Foo', to: 'Bar', kind: 'calls', verified: true }]);
    expect(graph.nodes.Foo!.verification).toBe('verified');
  });

  it('dedupes parallel edges (same from/to/kind)', async () => {
    const a = R('a.ts', [N('Foo'), N('Bar')], [E('Foo', 'Bar'), E('Foo', 'Bar')]);
    const { graph } = await aggregate({
      rootRequest: '', scope: 'workspace', analyses: [a], symbols: makeSymbols(),
    });
    expect(graph.edges).toHaveLength(1);
  });

  it('collects unique externalDeps from ext: edges', async () => {
    const a = R('a.ts', [N('Foo')], [
      { from: 'Foo', to: 'ext:lodash', kind: 'external_calls', verified: true },
      { from: 'Foo', to: 'ext:lodash', kind: 'external_calls', verified: true },
      { from: 'Foo', to: 'ext:react', kind: 'external_calls', verified: true },
    ]);
    const { graph } = await aggregate({
      rootRequest: '', scope: 'workspace', analyses: [a], symbols: makeSymbols(),
    });
    expect(graph.externalDeps.map(d => d.name).sort()).toEqual(['lodash', 'react']);
  });

  it('promotes ext: edges whose bare name is already an in-graph node id', async () => {
    // RecallEndpoints lumen regression: the LLM puts cross-FILE handler
    // names into external_calls per the v3 prompt, but if the handler is
    // in the same workspace we want a real class-to-class edge, not a
    // misleading "external dep".
    const a = R('a.ts', [N('RecallEndpoints')], [
      { from: 'RecallEndpoints', to: 'ext:RecallByQueryHandler', kind: 'external_calls', verified: true },
    ]);
    const b = R('b.ts', [N('RecallByQueryHandler', { file: 'b.ts' })]);
    const { graph } = await aggregate({
      rootRequest: '', scope: 'workspace', analyses: [a, b], symbols: makeSymbols(),
    });
    expect(graph.edges).toEqual([
      { from: 'RecallEndpoints', to: 'RecallByQueryHandler', kind: 'calls', verified: true },
    ]);
    expect(graph.externalDeps.map(d => d.name)).toEqual([]);
  });

  it('promotes ext: edges via workspace symbol lookup when bare name does not match an id', async () => {
    // Here `findInWorkspace` is the only signal — the LLM emitted a
    // slightly-off identifier, and the LSP confirms it resolves to the
    // in-graph canonical id.
    const a = R('a.ts', [N('Foo')], [
      { from: 'Foo', to: 'ext:Bar', kind: 'external_calls', verified: true },
    ]);
    const b = R('b.ts', [N('Bar', { file: 'b.ts' })]);
    const symbols = makeSymbols({
      Bar: [{ name: 'Bar', file: 'b.ts', startLine: 1, endLine: 10 }],
    });
    const { graph } = await aggregate({
      rootRequest: '', scope: 'workspace', analyses: [a, b], symbols,
    });
    expect(graph.edges.find(e => e.from === 'Foo')).toEqual({
      from: 'Foo', to: 'Bar', kind: 'calls', verified: true,
    });
    expect(graph.externalDeps).toEqual([]);
  });

  it('keeps ext: edges for names that do not resolve to any in-graph node', async () => {
    // Pure third-party dep: IEndpointRouteBuilder lives in ASP.NET Core,
    // not in workspace, not in graph — stays as an external dep.
    const a = R('a.ts', [N('Foo')], [
      { from: 'Foo', to: 'ext:IEndpointRouteBuilder', kind: 'external_calls', verified: true },
    ]);
    const { graph } = await aggregate({
      rootRequest: '', scope: 'workspace', analyses: [a], symbols: makeSymbols(),
    });
    expect(graph.edges).toEqual([
      { from: 'Foo', to: 'ext:IEndpointRouteBuilder', kind: 'external_calls', verified: true },
    ]);
    expect(graph.externalDeps).toEqual([{ name: 'IEndpointRouteBuilder', kind: 'package' }]);
  });

  it('scrubs droppedExternalCalls entries that got promoted to real calls edges', async () => {
    // The calibrator wrote ValidationFilter into droppedExternalCalls
    // because its findInWorkspace returned []. The aggregator later
    // discovered ValidationFilter is in fact an in-graph node and
    // promoted the edge. The card should no longer accuse it of being
    // "dropped".
    const recallEndpoints = N('RecallEndpoints', {
      verificationDetails: {
        rangeAdjusted: false,
        droppedCalls: [],
        droppedExternalCalls: ['ValidationFilter', 'NuGetPkg'],
      },
    });
    const a = R('a.ts', [recallEndpoints], [
      { from: 'RecallEndpoints', to: 'ext:ValidationFilter', kind: 'external_calls', verified: true },
      { from: 'RecallEndpoints', to: 'ext:NuGetPkg', kind: 'external_calls', verified: true },
    ]);
    const b = R('b.ts', [N('ValidationFilter', { file: 'b.ts' })]);
    const { graph } = await aggregate({
      rootRequest: '', scope: 'workspace', analyses: [a, b], symbols: makeSymbols(),
    });
    expect(graph.nodes.RecallEndpoints!.verificationDetails!.droppedExternalCalls).toEqual(['NuGetPkg']);
  });

  it('drops edges whose from-node was not merged', async () => {
    const a = R('a.ts', [], [E('Ghost', 'Bar', 'external_calls')]);
    const { graph } = await aggregate({
      rootRequest: '', scope: 'workspace', analyses: [a], symbols: makeSymbols(),
    });
    expect(graph.edges).toEqual([]);
  });

  it('threads summary fields from the first analyzer that provides them', async () => {
    const a = R('a.ts', [N('Foo')]);
    a.rootIntent = 'A';
    a.narrative = 'narA';
    a.suggestedEntryNodes = ['Foo'];
    const { graph } = await aggregate({
      rootRequest: 'q', scope: 'workspace', analyses: [a], symbols: makeSymbols(),
    });
    expect(graph.rootIntent).toBe('A');
    expect(graph.narrative).toBe('narA');
    expect(graph.suggestedEntryNodes).toEqual(['Foo']);
  });

  it('drops suggestedEntryNodes pointing at unknown classes', async () => {
    const a = R('a.ts', [N('Foo')]);
    a.suggestedEntryNodes = ['Foo', 'Ghost'];
    const { graph } = await aggregate({
      rootRequest: 'q', scope: 'workspace', analyses: [a], symbols: makeSymbols(),
    });
    expect(graph.suggestedEntryNodes).toEqual(['Foo']);
  });

  it('computes reading order on the merged graph', async () => {
    const a = R('a.ts', [
      N('Entry', { layer: 'entry' }),
      N('Helper'),
    ], [E('Entry', 'Helper')]);
    const { graph } = await aggregate({
      rootRequest: '', scope: 'workspace', analyses: [a], symbols: makeSymbols(),
    });
    expect(graph.readingOrder).toEqual(['Entry', 'Helper']);
  });
});
