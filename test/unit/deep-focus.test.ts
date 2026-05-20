import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { shouldDeepFocus, runDeepFocus } from '../../src/orchestrator/deep-focus';
import type { CodeMapGraph, CodeNode } from '../../src/shared/types';
import type { AnalyzeResult } from '../../src/orchestrator/single-file-analyzer';
import type { SymbolHit } from '../../src/calibration/symbol-provider';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeNode(id: string, overrides: Partial<CodeNode> = {}): CodeNode {
  return {
    id,
    kind: 'class',
    bc: 'shared',
    file: `src/${id}.ts`,
    range: { startLine: 1, endLine: 10 },
    methods: [{ name: 'doIt', line: 2 }],
    intent: '',
    risks: [],
    verification: 'verified',
    confidence: 1,
    readingPriority: 1,
    readState: 'unread',
    layer: 'service',
    ...overrides,
  };
}

function emptyGraph(extra: Partial<CodeMapGraph> = {}): CodeMapGraph {
  return {
    rootRequest: '',
    scope: 'workspace',
    nodes: {},
    edges: [],
    externalDeps: [],
    ...extra,
  };
}

const NEVER_CANCELLED = { isCancellationRequested: false } as never;

// ---------------------------------------------------------------------------
// shouldDeepFocus
// ---------------------------------------------------------------------------

describe('shouldDeepFocus', () => {
  it('returns true when the target lives in externalDeps', () => {
    const g = emptyGraph({ externalDeps: [{ name: 'Outsider', kind: 'package' }] });
    expect(shouldDeepFocus(g, 'Outsider')).toBe(true);
  });

  it('returns true for an unverified ghost node', () => {
    const ghost = makeNode('Ghost', { verification: 'unverified', methods: [] });
    const g = emptyGraph({ nodes: { Ghost: ghost } });
    expect(shouldDeepFocus(g, 'Ghost')).toBe(true);
  });

  it('returns true for a verified-but-methodless node', () => {
    const stub = makeNode('Stub', { methods: [] });
    const g = emptyGraph({ nodes: { Stub: stub } });
    expect(shouldDeepFocus(g, 'Stub')).toBe(true);
  });

  it('returns false for a fully-verified node with methods', () => {
    const ok = makeNode('Healthy');
    const g = emptyGraph({ nodes: { Healthy: ok } });
    expect(shouldDeepFocus(g, 'Healthy')).toBe(false);
  });

  it('returns false for an unknown target not in externalDeps either', () => {
    expect(shouldDeepFocus(emptyGraph(), 'NoSuch')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runDeepFocus
// ---------------------------------------------------------------------------

function fakeSymbols(hits: SymbolHit[]) {
  return {
    findInWorkspace: vi.fn().mockResolvedValue(hits),
    symbolsInFile: vi.fn().mockResolvedValue([]),
  } as never;
}
function fakeReader(files: Record<string, string>) {
  return {
    listFiles: vi.fn().mockResolvedValue(Object.keys(files)),
    readText: vi.fn().mockImplementation(async (p: string) => files[p]),
    resolveImport: vi.fn().mockResolvedValue(undefined),
  } as never;
}
function fakeLlm(emit: AnalyzeResult) {
  // We bypass the analyzer entirely by short-circuiting the cache path —
  // simpler than mocking the LLM stream + meta parser. The cache double
  // returns `emit` for any key and a no-op set().
  return {
    stream: async function* () {
      // The analyzer won't be reached when cache.get() returns a hit.
      yield '';
    },
  } as never;
}

describe('runDeepFocus', () => {
  it('returns symbol_not_found when the symbol provider finds nothing', async () => {
    const result = await runDeepFocus({
      targetClass: 'Missing',
      baseGraph: emptyGraph(),
      deps: {
        reader: fakeReader({}),
        symbols: fakeSymbols([]),
        llm: fakeLlm({} as never),
      },
      token: NEVER_CANCELLED,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('symbol_not_found');
  });

  it('returns file_not_found when the symbol resolves but the file is unreadable', async () => {
    const result = await runDeepFocus({
      targetClass: 'Foo',
      baseGraph: emptyGraph(),
      deps: {
        reader: fakeReader({}),
        symbols: fakeSymbols([
          { name: 'Foo', file: 'missing.ts', startLine: 1, endLine: 5, kind: 'Class' },
        ]),
        llm: fakeLlm({} as never),
      },
      token: NEVER_CANCELLED,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('file_not_found');
  });

  it('merges a cache-served analyzer result into the base graph and promotes ext: edges', async () => {
    // Base graph: AClient.use() -> ext:Server. After deep-focus on Server,
    // the edge should be rewritten to AClient -> Server (real calls edge),
    // and externalDeps should no longer list Server.
    const base = emptyGraph({
      nodes: { AClient: makeNode('AClient') },
      edges: [{ from: 'AClient', to: 'ext:Server', kind: 'external_calls' }],
      externalDeps: [{ name: 'Server', kind: 'package' }],
    });
    const analysisResult: AnalyzeResult = {
      file: 'src/Server.ts',
      nodes: [makeNode('Server', { file: 'src/Server.ts' })],
      edges: [],
      parseErrors: [],
    };
    const cache = {
      get: vi.fn().mockReturnValue(analysisResult),
      set: vi.fn().mockResolvedValue(undefined),
    } as never;
    const result = await runDeepFocus({
      targetClass: 'Server',
      baseGraph: base,
      deps: {
        reader: fakeReader({ 'src/Server.ts': 'export class Server {}' }),
        symbols: fakeSymbols([
          { name: 'Server', file: 'src/Server.ts', startLine: 1, endLine: 5, kind: 'Class' },
        ]),
        llm: fakeLlm({} as never),
        cache,
      },
      token: NEVER_CANCELLED,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fromCache).toBe(true);
    expect(result.upgradedIds).toContain('Server');
    expect(result.graph.nodes.Server).toBeDefined();
    expect(result.graph.externalDeps.find(d => d.name === 'Server')).toBeUndefined();
    const promoted = result.graph.edges.find(e => e.from === 'AClient' && e.to === 'Server');
    expect(promoted?.kind).toBe('calls');
  });

  it('does not downgrade an already-verified base node when re-analyzed', async () => {
    const base = emptyGraph({
      nodes: { Existing: makeNode('Existing', { confidence: 0.9, intent: 'rich' }) },
    });
    const analysisResult: AnalyzeResult = {
      file: 'src/Existing.ts',
      nodes: [makeNode('Existing', { confidence: 0.2, intent: 'poor' })],
      edges: [],
      parseErrors: [],
    };
    const cache = {
      get: vi.fn().mockReturnValue(analysisResult),
      set: vi.fn().mockResolvedValue(undefined),
    } as never;
    const result = await runDeepFocus({
      targetClass: 'Existing',
      baseGraph: base,
      deps: {
        reader: fakeReader({ 'src/Existing.ts': 'x' }),
        symbols: fakeSymbols([
          { name: 'Existing', file: 'src/Existing.ts', startLine: 1, endLine: 5, kind: 'Class' },
        ]),
        llm: fakeLlm({} as never),
        cache,
      },
      token: NEVER_CANCELLED,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.nodes.Existing.intent).toBe('rich');
    expect(result.upgradedIds).not.toContain('Existing');
  });

  it('registers new ext: edge targets in externalDeps so the webview can render them', async () => {
    // Analyzer for the focused class emits an external_calls edge to
    // ext:NewDep that the base graph never saw. mergeAnalysisIntoGraph must
    // append NewDep to externalDeps; otherwise cytoscape rejects the edge
    // with "non-existent target" and the render aborts.
    const base = emptyGraph({});
    const analysisResult: AnalyzeResult = {
      file: 'src/Focus.ts',
      nodes: [makeNode('Focus', { file: 'src/Focus.ts' })],
      edges: [{ from: 'Focus', to: 'ext:NewDep', kind: 'external_calls', verified: true }],
      parseErrors: [],
    };
    const cache = {
      get: vi.fn().mockReturnValue(analysisResult),
      set: vi.fn().mockResolvedValue(undefined),
    } as never;
    const result = await runDeepFocus({
      targetClass: 'Focus',
      baseGraph: base,
      deps: {
        reader: fakeReader({ 'src/Focus.ts': 'class Focus {}' }),
        symbols: fakeSymbols([
          { name: 'Focus', file: 'src/Focus.ts', startLine: 1, endLine: 5, kind: 'Class' },
        ]),
        llm: fakeLlm({} as never),
        cache,
      },
      token: NEVER_CANCELLED,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.externalDeps.find(d => d.name === 'NewDep')).toBeDefined();
  });
});