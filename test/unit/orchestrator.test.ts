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
    const reader = fakeFileReader({
      'apps/api/src/Lumen.Host/Program.cs': 'class Program {}',
      'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs': 'class CaptureEndpoints {}',
    });
    const llm = fakeLlm({
      'apps/api/src/Lumen.Host/Program.cs':
        metaBlock({ id: 'Program', calls: ['CaptureEndpoints'] }) + '\n' + SUMMARY,
      'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs':
        metaBlock({ id: 'CaptureEndpoints' }) + '\n' + SUMMARY,
    });
    const symbols = fakeSymbols({
      'apps/api/src/Lumen.Host/Program.cs': [sym('Program', 'apps/api/src/Lumen.Host/Program.cs', 1, 10)],
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

    expect(Object.keys(out.graph.nodes).sort()).toEqual(['CaptureEndpoints', 'Program']);
    expect(out.graph.edges).toEqual([
      { from: 'Program', to: 'CaptureEndpoints', kind: 'calls', verified: true },
    ]);
    expect(out.graph.nodes.Program!.boundedContext).toBe('host');
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
