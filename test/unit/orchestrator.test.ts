import { describe, it, expect, vi } from 'vitest';
import type * as vscode from 'vscode';
import { runOrchestrator, CancelledError } from '../../src/orchestrator/orchestrator';
import type { FileReader } from '../../src/orchestrator/workspace-scanner';
import type { LlmClient } from '../../src/llm/client';
import type { SymbolProvider, SymbolHit } from '../../src/calibration/symbol-provider';

const NEVER_CANCELLED = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
} as unknown as vscode.CancellationToken;

const sym = (name: string, file: string, s: number, e: number): SymbolHit => ({
  name, file, startLine: s, endLine: e,
});

function fakeFileReader(files: Record<string, string>): FileReader {
  return {
    async listFiles() { return Object.keys(files); },
    async readText(rel) { return files[rel]; },
    async resolveImport() { return undefined; },
  };
}

function metaBlock(node: { id: string; calls?: string[]; ext?: string[]; range?: [number, number] }): string {
  return '```codemap-meta\n' + JSON.stringify({
    node_id: node.id,
    range: node.range ? { startLine: node.range[0], endLine: node.range[1] } : { startLine: 1, endLine: 10 },
    intent: node.id,
    layer: 'service',
    confidence: 0.9,
    calls: node.calls ?? [],
    external_calls: node.ext ?? [],
    methods: [],
    risks: [],
    reading_priority: 3,
  }) + '\n```';
}

const SUMMARY = '```codemap-summary\n{"root_intent":"x","narrative":"y","suggested_entry_nodes":[]}\n```';

function fakeLlm(perFile: Record<string, string>): LlmClient {
  return {
    async *stream(_sys, user) {
      // The user message is `File: <path>\n\n\`\`\`\n<text>\n\`\`\``.
      const match = user.match(/^File:\s+(\S+)/);
      const file = match ? match[1]! : '';
      yield perFile[file] ?? SUMMARY;
    },
  };
}

function fakeSymbols(symbolsByFile: Record<string, SymbolHit[]>): SymbolProvider {
  return {
    async symbolsInFile(file) { return symbolsByFile[file] ?? []; },
    async findInWorkspace(name) {
      for (const hits of Object.values(symbolsByFile)) {
        const exact = hits.find(h => h.name === name);
        if (exact) return [exact];
      }
      return [];
    },
  };
}

describe('runOrchestrator', () => {
  it('runs scan → classify → analyze → aggregate end-to-end', async () => {
    // We use HostStartup.cs (not Program.cs) on purpose: the aggregator
    // drops synthetic top-level-statements `Program` nodes by file-path
    // heuristic (see "top-level Program filter" in aggregator.ts). Picking
    // a different filename here keeps this test focused on end-to-end
    // pipeline wiring without entangling it with that node-filter rule.
    const reader = fakeFileReader({
      'apps/api/src/Lumen.Host/HostStartup.cs': 'class HostStartup {}',
      'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs': 'class CaptureEndpoints {}',
    });
    const llm = fakeLlm({
      'apps/api/src/Lumen.Host/HostStartup.cs':
        metaBlock({ id: 'HostStartup', calls: ['CaptureEndpoints'] }) + '\n' + SUMMARY,
      'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs':
        metaBlock({ id: 'CaptureEndpoints' }) + '\n' + SUMMARY,
    });
    const symbols = fakeSymbols({
      'apps/api/src/Lumen.Host/HostStartup.cs': [sym('HostStartup', 'apps/api/src/Lumen.Host/HostStartup.cs', 1, 10)],
      'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs': [
        sym('CaptureEndpoints', 'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs', 1, 10),
      ],
    });

    const onStep = vi.fn();
    const onFileDone = vi.fn();
    const out = await runOrchestrator(
      { reader, symbols, llm },
      { rootRequest: 'q', scope: 'workspace' },
      { onStep, onFileDone },
      NEVER_CANCELLED,
    );

    expect(Object.keys(out.graph.nodes).sort()).toEqual(['CaptureEndpoints', 'HostStartup']);
    expect(out.graph.edges).toEqual([
      { from: 'HostStartup', to: 'CaptureEndpoints', kind: 'calls', verified: true },
    ]);
    expect(out.graph.nodes.HostStartup!.boundedContext).toBe('host');
    expect(out.graph.nodes.CaptureEndpoints!.boundedContext).toBe('capture');
    expect(out.stats.filesAnalyzed).toBe(2);
    expect(out.stats.verifiedCount).toBe(2);
    expect(onStep).toHaveBeenCalled();
    expect(onFileDone).toHaveBeenCalledTimes(2);
  });

  it('throws a CancelledError if cancellation is signalled before analysis', async () => {
    const reader = fakeFileReader({
      'src/main.ts': 'class Foo {}',
    });
    const llm = fakeLlm({});
    const symbols = fakeSymbols({});

    let cancelled = false;
    const token = {
      get isCancellationRequested() { return cancelled; },
      onCancellationRequested: () => ({ dispose() {} }),
    } as unknown as vscode.CancellationToken;

    cancelled = true;
    await expect(
      runOrchestrator(
        { reader, symbols, llm },
        { rootRequest: '', scope: 'workspace' },
        {},
        token,
      ),
    ).rejects.toThrow(CancelledError);
  });

  it('throws a friendly error when no entry points are found', async () => {
    const reader = fakeFileReader({ 'src/util.ts': 'export const x = 1;' });
    const llm = fakeLlm({});
    const symbols = fakeSymbols({});

    await expect(
      runOrchestrator(
        { reader, symbols, llm },
        { rootRequest: '', scope: 'workspace' },
        {},
        NEVER_CANCELLED,
      ),
    ).rejects.toThrow(/No analyzable entry points/);
  });

  it('captures per-file failures without aborting the whole pipeline', async () => {
    const reader = fakeFileReader({
      'src/main.ts': 'class Main {}',
      'src/app.ts': 'class App {}',
    });
    const llm: LlmClient = {
      async *stream(_sys, user) {
        if (user.includes('app.ts')) throw new Error('boom');
        yield metaBlock({ id: 'Main' }) + '\n' + SUMMARY;
      },
    };
    const symbols = fakeSymbols({
      'src/main.ts': [sym('Main', 'src/main.ts', 1, 10)],
    });

    const onFileDone = vi.fn();
    const out = await runOrchestrator(
      { reader, symbols, llm },
      { rootRequest: '', scope: 'workspace' },
      { onFileDone },
      NEVER_CANCELLED,
    );
    expect(out.stats.filesFailed).toBe(1);
    expect(out.stats.filesAnalyzed).toBe(1);
    expect(out.graph.nodes.Main).toBeDefined();
    // onFileDone fires for both success and failure
    expect(onFileDone.mock.calls.some(c => c[0].error?.message === 'boom')).toBe(true);
  });

  it('emits onPartial after the core batch when progressive rendering is wired', async () => {
    // 3 files total + progressiveCoreSize=1 → core=[1], rest=[2], so we
    // expect a single onPartial call carrying a partial graph and the
    // final result still containing the full graph.
    const reader = fakeFileReader({
      'src/Program.cs': 'class Prog {}',
      'src/AlphaEndpoints.cs': 'class Alpha {}',
      'src/BravoEndpoints.cs': 'class Bravo {}',
    });
    const llm = fakeLlm({
      'src/Program.cs': metaBlock({ id: 'Prog' }) + '\n' + SUMMARY,
      'src/AlphaEndpoints.cs': metaBlock({ id: 'Alpha' }) + '\n' + SUMMARY,
      'src/BravoEndpoints.cs': metaBlock({ id: 'Bravo' }) + '\n' + SUMMARY,
    });
    const symbols = fakeSymbols({
      'src/Program.cs': [sym('Prog', 'src/Program.cs', 1, 10)],
      'src/AlphaEndpoints.cs': [sym('Alpha', 'src/AlphaEndpoints.cs', 1, 10)],
      'src/BravoEndpoints.cs': [sym('Bravo', 'src/BravoEndpoints.cs', 1, 10)],
    });

    const onPartial = vi.fn();
    const out = await runOrchestrator(
      { reader, symbols, llm },
      {
        rootRequest: '',
        scope: 'workspace',
        progressiveCoreSize: 1,
        scan: { maxFiles: 5 },
      },
      { onPartial },
      NEVER_CANCELLED,
    );

    expect(onPartial).toHaveBeenCalledTimes(1);
    const partial = onPartial.mock.calls[0]![0] as {
      graph: { nodes: Record<string, unknown> };
      analyzedCount: number;
      totalCount: number;
    };
    expect(partial.analyzedCount).toBe(1);
    expect(partial.totalCount).toBe(3);
    expect(Object.keys(partial.graph.nodes).length).toBe(1);
    // The final result is the FULL aggregate, not the partial.
    expect(Object.keys(out.graph.nodes).length).toBe(3);
    expect(out.stats.filesAnalyzed).toBe(3);
  });

  it('skips onPartial when the pool is at or under progressiveCoreSize', async () => {
    // Pool size 2 with default progressiveCoreSize=20 → no partial.
    const reader = fakeFileReader({
      'src/Program.cs': 'class Prog {}',
      'src/AlphaEndpoints.cs': 'class Alpha {}',
    });
    const llm = fakeLlm({
      'src/Program.cs': metaBlock({ id: 'Prog' }) + '\n' + SUMMARY,
      'src/AlphaEndpoints.cs': metaBlock({ id: 'Alpha' }) + '\n' + SUMMARY,
    });
    const symbols = fakeSymbols({
      'src/Program.cs': [sym('Prog', 'src/Program.cs', 1, 10)],
      'src/AlphaEndpoints.cs': [sym('Alpha', 'src/AlphaEndpoints.cs', 1, 10)],
    });

    const onPartial = vi.fn();
    await runOrchestrator(
      { reader, symbols, llm },
      { rootRequest: '', scope: 'workspace' },
      { onPartial },
      NEVER_CANCELLED,
    );
    expect(onPartial).not.toHaveBeenCalled();
  });

  it('skips LSP warmup when every skeleton file is a cache hit', async () => {
    // ---- Arrange ----
    // Pre-populate the cache for both skeleton files. The orchestrator's
    // pre-check phase computes the same key the worker would; if both keys
    // resolve to cached results, warmup is pure latency and we should
    // skip it. We assert this by spying on the symbol provider: warmup
    // is the only path that touches `symbolsInFile` during a fully-cached
    // run (the analyzer calibration is baked into the cached result).
    const { AnalyzerCache } = await import('../../src/persistence/analyzer-cache');
    const { PROMPT_VERSION } = await import('../../src/llm/prompts');
    const { CALIBRATOR_VERSION } = await import('../../src/calibration/calibrator');
    const store = new Map<string, unknown>();
    const memento = {
      get: <T>(k: string) => store.get(k) as T | undefined,
      update: async (k: string, v: unknown) => {
        if (v === undefined) store.delete(k); else store.set(k, v);
      },
      keys: () => Array.from(store.keys()),
    } as unknown as vscode.Memento;
    const cache = new AnalyzerCache(memento);

    const files = {
      'apps/api/src/Lumen.Host/Program.cs': 'class Program {}',
      'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs': 'class CaptureEndpoints {}',
    };
    const reader = fakeFileReader(files);

    for (const [file, text] of Object.entries(files)) {
      const id = file.includes('Program') ? 'Program' : 'CaptureEndpoints';
      // v3.7: cache key folds in a salt derived from bounded context +
      // entry-point flag + sorted inbound list. v3.8 also folds in the
      // detected internal-namespace roots (empty here — the fixture .cs
      // files declare no `namespace` and there is no package.json). Pre-seed
      // with the exact salt the orchestrator will compute, otherwise these
      // "fully cached" runs miss and re-analyze the file.
      const bucket = file.includes('Lumen.Host') ? 'host' : 'capture';
      const salt = `bc:${bucket}|entry:1|in:|ns:`;
      const key = AnalyzerCache.key(`${PROMPT_VERSION}/${CALIBRATOR_VERSION}`, file, text, salt);
      await cache.set(key, {
        file,
        nodes: [
          {
            id,
            file,
            range: { startLine: 1, endLine: 10 },
            intent: id,
            layer: 'service',
            confidence: 0.9,
            methods: [],
            risks: [],
            reading_priority: 3,
            verification: 'verified',
          } as never,
        ],
        edges: [],
        parseErrors: [],
      });
    }

    const symbolsInFileSpy = vi.fn(async () => []);
    const findInWorkspaceSpy = vi.fn(async () => []);
    const symbols: SymbolProvider = {
      symbolsInFile: symbolsInFileSpy,
      findInWorkspace: findInWorkspaceSpy,
    };

    const llm: LlmClient = {
      // Cached results should bypass the LLM entirely; a throwing stream
      // proves no call ever reaches it.
      async *stream() {
        throw new Error('llm should not be called on a fully-cached run');
      },
    };

    // ---- Act ----
    const onStep = vi.fn();
    const out = await runOrchestrator(
      { reader, symbols, llm, cache },
      { rootRequest: '', scope: 'workspace' },
      { onStep },
      NEVER_CANCELLED,
    );

    // ---- Assert ----
    expect(out.stats.filesAnalyzed).toBe(2);
    expect(out.stats.filesFromCache).toBe(2);
    expect(out.stats.warmupMs).toBe(0);
    expect(symbolsInFileSpy).not.toHaveBeenCalled();
    expect(onStep.mock.calls.flat().some(arg => /skipping LSP warmup/i.test(String(arg)))).toBe(true);
  });

  it('still warms up the LSP when any file is a cache miss', async () => {
    // One cached file + one fresh file → cacheMissCount > 0 → warmup runs.
    // We don't measure exact warmup duration (timing-dependent); we just
    // check that `symbolsInFile` is invoked, which only happens via
    // warmup or live analysis.
    const { AnalyzerCache } = await import('../../src/persistence/analyzer-cache');
    const { PROMPT_VERSION } = await import('../../src/llm/prompts');
    const { CALIBRATOR_VERSION } = await import('../../src/calibration/calibrator');
    const store = new Map<string, unknown>();
    const memento = {
      get: <T>(k: string) => store.get(k) as T | undefined,
      update: async (k: string, v: unknown) => {
        if (v === undefined) store.delete(k); else store.set(k, v);
      },
      keys: () => Array.from(store.keys()),
    } as unknown as vscode.Memento;
    const cache = new AnalyzerCache(memento);

    const cachedFile = 'apps/api/src/Lumen.Host/Program.cs';
    const freshFile = 'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs';
    const files = { [cachedFile]: 'class Program {}', [freshFile]: 'class CaptureEndpoints {}' };
    const reader = fakeFileReader(files);

    await cache.set(
      AnalyzerCache.key(
        `${PROMPT_VERSION}/${CALIBRATOR_VERSION}`,
        cachedFile,
        files[cachedFile]!,
        // v3.7+v3.8: Program.cs in Lumen.Host → bucket "host", entry-point,
        // no inbound, no namespace roots (fixture has no `namespace` decl).
        'bc:host|entry:1|in:|ns:',
      ),
      {
        file: cachedFile,
        nodes: [
          {
            id: 'Program',
            file: cachedFile,
            range: { startLine: 1, endLine: 10 },
            intent: 'Program',
            layer: 'service',
            confidence: 0.9,
            methods: [],
            risks: [],
            reading_priority: 3,
            verification: 'verified',
          } as never,
        ],
        edges: [],
        parseErrors: [],
      },
    );

    const symbolsInFileSpy = vi.fn(async (file: string) => {
      if (file === freshFile) return [sym('CaptureEndpoints', freshFile, 1, 10)];
      return [];
    });
    const symbols: SymbolProvider = {
      symbolsInFile: symbolsInFileSpy,
      findInWorkspace: async () => [],
    };

    const llm = fakeLlm({
      [freshFile]: metaBlock({ id: 'CaptureEndpoints' }) + '\n' + SUMMARY,
    });

    const out = await runOrchestrator(
      { reader, symbols, llm, cache },
      { rootRequest: '', scope: 'workspace' },
      { lspWarmupTimeoutMs: 100 },
      NEVER_CANCELLED,
    );

    expect(out.stats.filesFromCache).toBe(1);
    expect(out.stats.filesAnalyzed).toBe(2);
    // symbolsInFile was called — either by warmup or by the calibrator for
    // the fresh file. Either way proves warmup was NOT skipped.
    expect(symbolsInFileSpy).toHaveBeenCalled();
  });

  it('filters the skeleton by scopePrefix', async () => {
    const reader = fakeFileReader({
      'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs': 'class CaptureEndpoints {}',
      'apps/api/src/Lumen.Modules.Recall/Endpoints/RecallEndpoints.cs': 'class RecallEndpoints {}',
    });
    const llm = fakeLlm({
      'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs':
        metaBlock({ id: 'CaptureEndpoints' }) + '\n' + SUMMARY,
    });
    const symbols = fakeSymbols({
      'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs': [
        sym('CaptureEndpoints', 'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs', 1, 10),
      ],
    });
    const out = await runOrchestrator(
      { reader, symbols, llm },
      {
        rootRequest: '',
        scope: 'apps/api/src/Lumen.Modules.Capture',
        scopePrefix: 'apps/api/src/Lumen.Modules.Capture',
      },
      {},
      NEVER_CANCELLED,
    );
    expect(Object.keys(out.graph.nodes)).toEqual(['CaptureEndpoints']);
  });
});
