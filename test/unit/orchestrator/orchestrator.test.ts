// Phase 3.3a -- runOrchestrator unit tests.
//
// Mocks every external surface so we exercise the wiring without fs,
// vscode, or a real LLM/calibrator. The lumen real-data run is the
// 3.3b HITL checkpoint.

import { describe, expect, it } from 'vitest';
import { runOrchestrator } from '../../../src/orchestrator/orchestrator';
import type { LlmClient, LlmStreamRequest } from '../../../src/orchestrator/llm-client';
import type { FileReader } from '../../../src/orchestrator/workspace-scanner';
import type { CalibratorService } from '../../../src/calibration/calibrator-service';
import type {
  Callee,
  LoadSolutionParams,
  LoadSolutionResult,
  ResolveCalleesParams,
  ResolveCalleesResult,
} from '../../../src/shared/calibrator-protocol';

class MapReader implements FileReader {
  constructor(private readonly files: Map<string, string>) {}
  async listFiles(): Promise<string[]> {
    return [...this.files.keys()];
  }
  async readText(rel: string): Promise<string | undefined> {
    return this.files.get(rel);
  }
}

class CannedLlmClient implements LlmClient {
  constructor(private readonly byFile: Map<string, string>) {}
  async *stream(req: LlmStreamRequest): AsyncIterable<string> {
    const m = /^File: (.+)$/m.exec(req.userMessage);
    const file = m?.[1] ?? '';
    const reply = this.byFile.get(file);
    if (reply) yield reply;
  }
}

class FakeCalibrator implements CalibratorService {
  public resolveCalls = 0;
  constructor(private readonly byMethod: Map<string, Callee[]>) {}
  async loadSolution(_p: LoadSolutionParams): Promise<LoadSolutionResult> {
    return {
      slnxPath: '',
      declaredProjectCount: 0,
      loadedProjectCount: 0,
      distinctProjectCount: 0,
      projects: [],
      skipped: [],
      diagnostics: [],
      elapsedMs: 0,
    };
  }
  async resolveCallees(p: ResolveCalleesParams): Promise<ResolveCalleesResult> {
    this.resolveCalls++;
    const key = `${p.classId}.${p.methodName}`;
    return {
      filePath: p.filePath,
      classId: p.classId,
      methodName: p.methodName,
      methodFullyQualifiedName: key,
      callees: this.byMethod.get(key) ?? [],
      elapsedMs: 0,
    };
  }
  async dispose(): Promise<void> {}
}

function metaReply(classes: object[], methods: object[]): string {
  return [
    '```codemap-meta',
    JSON.stringify({ classes, methods }, null, 2),
    '```',
    '',
    '```codemap-summary',
    JSON.stringify({ rootIntent: 'r', narrative: 'n' }, null, 2),
    '```',
  ].join('\n');
}

const FILE_A = 'apps/api/src/Lumen.Modules.Capture/A.cs';
const FILE_B = 'apps/api/src/Lumen.Modules.Capture/B.cs';

const REPLY_A = metaReply(
  [{
    id: 'A',
    kind: 'class',
    range: { startLine: 1, endLine: 30 },
    intent: 'a class',
    confidence: 0.9,
    risks: [],
    methodIds: ['A.Do'],
    isEntry: true,
    entryKind: 'http_endpoint',
    entryMeta: { routes: ['POST /a'] },
  }],
  [{
    id: 'A.Do',
    ownerClassId: 'A',
    name: 'Do',
    signature: '(int x)',
    line: 5,
    visibility: 'public',
    isStatic: false,
    intent: 'do',
    risks: [],
  }],
);

const REPLY_B = metaReply(
  [{
    id: 'B',
    kind: 'class',
    range: { startLine: 1, endLine: 20 },
    intent: 'b class',
    confidence: 0.9,
    risks: [],
    methodIds: ['B.Run'],
  }],
  [{
    id: 'B.Run',
    ownerClassId: 'B',
    name: 'Run',
    signature: '()',
    line: 5,
    visibility: 'public',
    isStatic: false,
    intent: 'run',
    risks: [],
  }],
);

function makeDeps(opts: { withCalibrator?: boolean } = {}) {
  const reader = new MapReader(new Map([
    [FILE_A, 'public class A { public void Do(int x) {} }'],
    [FILE_B, 'public class B { public void Run() {} }'],
  ]));
  const llm = new CannedLlmClient(new Map([
    [FILE_A, REPLY_A],
    [FILE_B, REPLY_B],
  ]));
  const calibrator = new FakeCalibrator(new Map([
    ['A.Do', [{
      displayName: 'B.Run()',
      fullyQualifiedName: 'B.Run',
      containingType: 'B',
      methodName: 'Run',
      kind: 'method',
      isExternal: false,
      isExtension: false,
      filePath: FILE_B,
      line: 5,
      invocationLine: 5,
    }]],
    ['B.Run', []],
  ]));
  return {
    deps: opts.withCalibrator
      ? { reader, llm, calibratorFor: () => calibrator }
      : { reader, llm },
    calibrator,
  };
}

describe('runOrchestrator', () => {
  it('produces a v2 graph end-to-end with calibrator-resolved edges', async () => {
    const { deps, calibrator } = makeDeps({ withCalibrator: true });
    const events: string[] = [];
    const result = await runOrchestrator(
      deps,
      { rootRequest: '/scope apps/api/src', scope: 'apps/api/src' },
      { onStep: (s) => events.push(s) },
    );

    expect(result.graph.schemaVersion).toBe(2);
    expect(Object.keys(result.graph.classes).sort()).toEqual(['A', 'B']);
    expect(Object.keys(result.graph.methods).sort()).toEqual(['A.Do', 'B.Run']);
    expect(result.graph.methodEdges).toEqual([
      { id: 'e0', source: 'A.Do', target: 'B.Run', kind: 'calls', verified: true },
    ]);
    expect(result.graph.entryMethodIds).toEqual(['A.Do']);
    expect(result.graph.classes.A!.boundedContext).toBe('capture');
    expect(calibrator.resolveCalls).toBe(2);
    expect(result.stats.classCount).toBe(2);
    expect(result.stats.methodEdgeCount).toBe(1);
    expect(events).toContain('Aggregating graph');
  });

  it('skips calibration entirely when calibratorFor is omitted', async () => {
    const { deps } = makeDeps({ withCalibrator: false });
    const result = await runOrchestrator(
      deps,
      { rootRequest: 'r', scope: 's' },
    );
    expect(result.graph.methodEdges).toEqual([]);
    expect(result.graph.methods['A.Do']!.verification).toBe('unverified');
    expect(result.stats.methodsCalibrated).toBe(0);
  });

  it('respects scopePrefix and only analyzes in-scope files', async () => {
    const reader = new MapReader(new Map([
      ['apps/api/src/Lumen.Modules.Capture/A.cs', 'cs'],
      ['apps/api/src/Lumen.Modules.Recall/Z.cs', 'cs'],
      ['unrelated/junk.cs', 'cs'],
    ]));
    const seen: string[] = [];
    class TrackingLlm implements LlmClient {
      async *stream(req: LlmStreamRequest): AsyncIterable<string> {
        const m = /^File: (.+)$/m.exec(req.userMessage);
        if (m) seen.push(m[1]!);
        yield metaReply([], []);
      }
    }
    const result = await runOrchestrator(
      { reader, llm: new TrackingLlm() },
      { rootRequest: 'r', scope: 's', scopePrefix: 'apps/api/src/Lumen.Modules.Capture' },
    );
    expect(seen).toEqual(['apps/api/src/Lumen.Modules.Capture/A.cs']);
    expect(result.stats.filesScanned).toBe(1);
  });

  it('returns an empty graph when no files match the scope', async () => {
    const reader = new MapReader(new Map([['unrelated/x.cs', 'cs']]));
    const result = await runOrchestrator(
      { reader, llm: new CannedLlmClient(new Map()) },
      { rootRequest: 'r', scope: 's', scopePrefix: 'does/not/exist' },
    );
    expect(result.stats.filesScanned).toBe(0);
    expect(Object.keys(result.graph.classes)).toEqual([]);
  });

  it('records calibrator errors as warnings without failing the run', async () => {
    const reader = new MapReader(new Map([[FILE_A, 'cs']]));
    const llm = new CannedLlmClient(new Map([[FILE_A, REPLY_A]]));
    class ThrowingCalibrator implements CalibratorService {
      async loadSolution(): Promise<LoadSolutionResult> {
        throw new Error('not used');
      }
      async resolveCallees(): Promise<ResolveCalleesResult> {
        throw new Error('LSP cold');
      }
      async dispose(): Promise<void> {}
    }
    const result = await runOrchestrator(
      { reader, llm, calibratorFor: () => new ThrowingCalibrator() },
      { rootRequest: 'r', scope: 's' },
    );
    expect(result.stats.methodsFailed).toBe(1);
    expect(result.warnings.some((w) => w.includes('calibrator failed for A.Do'))).toBe(true);
    expect(result.graph.methods['A.Do']!.verification).toBe('unverified');
  });
});
