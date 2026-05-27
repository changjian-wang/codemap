import { describe, it, expect, vi } from 'vitest';
import type * as vscode from 'vscode';
import { SingleFileAnalyzer } from '../../src/orchestrator/single-file-analyzer';
import type { LlmClient } from '../../src/llm/client';
import type { SymbolProvider, SymbolHit } from '../../src/calibration/symbol-provider';

const NEVER_CANCELLED = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
} as unknown as vscode.CancellationToken;

const sym = (name: string, file: string, s: number, e: number): SymbolHit => ({
  name, file, startLine: s, endLine: e,
});

function fakeLlm(chunks: string[]): LlmClient {
  return {
    async *stream() {
      for (const c of chunks) yield c;
    },
  };
}

function fakeSymbols(args: { inFile?: Record<string, SymbolHit[]> } = {}): SymbolProvider {
  return {
    async symbolsInFile(f) { return args.inFile?.[f] ?? []; },
    async findInWorkspace() { return []; },
  };
}

const META_FOO = '```codemap-meta\n' + JSON.stringify({
  node_id: 'Foo',
  range: { startLine: 1, endLine: 30 },
  intent: 'foo',
  calls: ['Bar'],
  external_calls: ['HttpClient.GetAsync'],
  methods: [{ name: 'doThing', signature: '(x)', line: 5, risks: ['concurrency'] }],
  risks: [{ type: 'concurrency', desc: 'shared state' }],
}) + '\n```';

const META_BAR = '```codemap-meta\n' + JSON.stringify({
  node_id: 'Bar',
  range: { startLine: 32, endLine: 60 },
  intent: 'bar',
}) + '\n```';

const SUMMARY = '```codemap-summary\n' + JSON.stringify({
  root_intent: 'two classes',
  narrative: 'read Foo first',
  suggested_entry_nodes: ['Foo'],
}) + '\n```';

describe('SingleFileAnalyzer', () => {
  it('streams chunks, parses meta + summary, calibrates each block', async () => {
    const llm = fakeLlm([META_FOO + '\n', META_BAR + '\n', SUMMARY]);
    const symbols = fakeSymbols({
      inFile: { 'a.cs': [sym('Foo', 'a.cs', 1, 30), sym('Bar', 'a.cs', 32, 60)] },
    });
    const a = new SingleFileAnalyzer(llm, symbols);
    const r = await a.analyze({
      file: 'a.cs',
      fileText: 'class Foo {} class Bar {}',
      boundedContext: 'capture',
      token: NEVER_CANCELLED,
    });
    expect(r.nodes.map(n => n.id).sort()).toEqual(['Bar', 'Foo']);
    expect(r.rootIntent).toBe('two classes');
    expect(r.narrative).toBe('read Foo first');
    expect(r.suggestedEntryNodes).toEqual(['Foo']);
  });

  it('fires onNode incrementally as each calibrated node is ready', async () => {
    const llm = fakeLlm([META_FOO, META_BAR, SUMMARY]);
    const symbols = fakeSymbols({
      inFile: { 'a.cs': [sym('Foo', 'a.cs', 1, 30), sym('Bar', 'a.cs', 32, 60)] },
    });
    const onNode = vi.fn();
    const a = new SingleFileAnalyzer(llm, symbols);
    await a.analyze({
      file: 'a.cs',
      fileText: '...',
      boundedContext: 'capture',
      token: NEVER_CANCELLED,
      onNode,
    });
    expect(onNode).toHaveBeenCalledTimes(2);
    expect(onNode.mock.calls[0]![0].id).toBe('Foo');
    expect(onNode.mock.calls[1]![0].id).toBe('Bar');
  });

  it('survives malformed JSON in one block without losing the others', async () => {
    const broken = '```codemap-meta\n{not json}\n```\n';
    const llm = fakeLlm([broken + META_BAR + '\n' + SUMMARY]);
    const symbols = fakeSymbols({
      inFile: { 'a.cs': [sym('Bar', 'a.cs', 32, 60)] },
    });
    const a = new SingleFileAnalyzer(llm, symbols);
    const r = await a.analyze({
      file: 'a.cs', fileText: '...', boundedContext: 'capture', token: NEVER_CANCELLED,
    });
    expect(r.nodes.map(n => n.id)).toEqual(['Bar']);
    expect(r.parseErrors).toHaveLength(1);
    expect(r.parseErrors[0]!.reason).toMatch(/JSON parse failed/);
  });

  it('propagates verification state to nodes (unverified when symbol missing)', async () => {
    const llm = fakeLlm([META_FOO + SUMMARY]);
    const symbols = fakeSymbols({ inFile: { 'a.cs': [] } });  // empty — no Foo
    const a = new SingleFileAnalyzer(llm, symbols);
    const r = await a.analyze({
      file: 'a.cs', fileText: '...', boundedContext: 'capture', token: NEVER_CANCELLED,
    });
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]!.verification).toBe('unverified');
  });

  it('stops feeding the LLM once cancellation is requested', async () => {
    let chunks = 0;
    let cancelled = false;
    const llm: LlmClient = {
      async *stream() {
        for (let i = 0; i < 100; i++) {
          // Slow enough that the setTimeout below has time to flip the flag.
          await new Promise(r => setTimeout(r, 2));
          chunks++;
          yield 'x';
        }
      },
    };
    const token = {
      get isCancellationRequested() { return cancelled; },
      onCancellationRequested: () => ({ dispose() {} }),
    } as unknown as vscode.CancellationToken;
    setTimeout(() => { cancelled = true; }, 20);
    const a = new SingleFileAnalyzer(llm, fakeSymbols());
    await a.analyze({
      file: 'a.cs', fileText: '', boundedContext: 'capture', token,
    });
    expect(chunks).toBeLessThan(100);
  });

  it('threads workspace hints (isEntryPoint + inboundImports) into the user message (v3.7)', async () => {
    let capturedUser = '';
    const llm: LlmClient = {
      async *stream(_system, user) {
        capturedUser = user;
        yield SUMMARY;
      },
    };
    const a = new SingleFileAnalyzer(llm, fakeSymbols());
    await a.analyze({
      file: 'src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs',
      fileText: 'public static class CaptureEndpoints {}',
      boundedContext: 'capture',
      isEntryPoint: true,
      inboundImports: ['src/Lumen.Host/Program.cs'],
      token: NEVER_CANCELLED,
    });
    expect(capturedUser).toContain('Bounded context: capture');
    expect(capturedUser).toContain('Entry-point filename match: yes');
    expect(capturedUser).toContain('Inbound imports (workspace scan, 1):');
    expect(capturedUser).toContain('  - src/Lumen.Host/Program.cs');
  });

  it('emits inbound "none" line when scan produced an empty caller list', async () => {
    let capturedUser = '';
    const llm: LlmClient = {
      async *stream(_system, user) {
        capturedUser = user;
        yield SUMMARY;
      },
    };
    const a = new SingleFileAnalyzer(llm, fakeSymbols());
    await a.analyze({
      file: 'src/Foo.cs',
      fileText: 'public class Foo {}',
      boundedContext: 'capture',
      inboundImports: [],
      token: NEVER_CANCELLED,
    });
    expect(capturedUser).toContain('Inbound imports (workspace scan): none.');
  });

  it('omits the new v3.7 hint lines when isEntryPoint/inboundImports are not supplied', async () => {
    let capturedUser = '';
    const llm: LlmClient = {
      async *stream(_system, user) {
        capturedUser = user;
        yield SUMMARY;
      },
    };
    const a = new SingleFileAnalyzer(llm, fakeSymbols());
    await a.analyze({
      file: 'src/Foo.cs',
      fileText: 'public class Foo {}',
      boundedContext: 'capture',
      token: NEVER_CANCELLED,
    });
    expect(capturedUser).not.toContain('Entry-point filename match');
    expect(capturedUser).not.toContain('Inbound imports');
  });
});
