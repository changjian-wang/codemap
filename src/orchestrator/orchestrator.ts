// Phase 3.3a -- end-to-end driver.
//
// Glues the four moving parts:
//   1. workspace-scanner.ts  -> file list
//   2. analyze-file.ts       -> per-file ClassNode + MethodNode  (LLM)
//   3. CalibratorService     -> per-method callees                (LSP)
//   4. aggregator.ts         -> single CodeMapGraph
//
// Dependencies are constructor-injected so unit tests can swap in mocks
// for every external surface (no fs, no vscode, no real LLM). The chat
// participant rewires this with the production FileReader / VscodeLmClient
// / CalibratorRegistry in slice 3.3b.

import type { Callee, ResolveCalleesParams } from '../shared/calibrator-protocol';
import type { CodeMapGraph } from '../shared/types';
import type { CalibratorService } from '../calibration/calibrator-service';
import { aggregate, type AggregateResult } from './aggregator';
import { analyzeFile, type AnalyzeInput, type AnalyzeResult } from './analyze-file';
import type { LlmClient } from './llm-client';
import {
  DEFAULT_SCAN_OPTIONS,
  scanWorkspace,
  type FileReader,
  type ScanOptions,
} from './workspace-scanner';

export interface OrchestratorDeps {
  reader: FileReader;
  llm: LlmClient;
  /**
   * Per-language calibrator resolver. Returning `undefined` skips
   * calibration for files in that language (all methods stay
   * verification='unverified' with no outgoing edges). The chat
   * participant wires this to CalibratorRegistry.getCalibrator.
   */
  calibratorFor?: (languageId: string) => CalibratorService | undefined;
}

export interface OrchestratorOptions {
  rootRequest: string;
  scope: string;
  scopePrefix?: string;
  workspaceRoot?: string;
  scan?: Partial<ScanOptions>;
  /** Parallel cap for LLM analysis. Default 6. */
  analyzeConcurrency?: number;
  /** Parallel cap for calibrator resolveCallees. Default 8. */
  calibrateConcurrency?: number;
}

export interface OrchestratorEvents {
  onStep?: (msg: string) => void;
  onSkeleton?: (files: readonly string[]) => void;
  onFileAnalyzed?: (info: { file: string; classes: number; methods: number; error?: Error }) => void;
  onMethodCalibrated?: (info: { methodId: string; callees: number; error?: Error }) => void;
}

export interface OrchestratorStats {
  filesScanned: number;
  filesAnalyzed: number;
  filesFailed: number;
  methodsCalibrated: number;
  methodsFailed: number;
  classCount: number;
  methodCount: number;
  methodEdgeCount: number;
  classEdgeCount: number;
  durationMs: number;
}

export interface OrchestratorResult {
  graph: CodeMapGraph;
  stats: OrchestratorStats;
  warnings: string[];
  /** Files whose LLM analysis threw, paired with the error. */
  failures: { file: string; error: Error }[];
}

export async function runOrchestrator(
  deps: OrchestratorDeps,
  options: OrchestratorOptions,
  events: OrchestratorEvents = {},
  signal?: AbortSignal,
): Promise<OrchestratorResult> {
  const t0 = Date.now();
  const scanOpts: ScanOptions = {
    ...DEFAULT_SCAN_OPTIONS,
    ...options.scan,
    ...(options.scopePrefix ? { scopePrefix: options.scopePrefix } : {}),
  };

  events.onStep?.(`Scanning workspace (cap ${scanOpts.maxFiles})`);
  const files = await scanWorkspace(deps.reader, scanOpts);
  throwIfAborted(signal);
  events.onSkeleton?.(files);

  if (files.length === 0) {
    return emptyResult(options, t0);
  }

  events.onStep?.(`Analyzing ${files.length} files`);
  const analyzeConcurrency = options.analyzeConcurrency ?? 6;
  const { analyses, failures } = await analyzeAll(
    files,
    deps,
    events,
    analyzeConcurrency,
    signal,
  );
  throwIfAborted(signal);

  events.onStep?.(`Calibrating callees`);
  const calibrateConcurrency = options.calibrateConcurrency ?? 8;
  const calibrationWarnings: string[] = [];
  const callees = await calibrateAll(
    analyses,
    deps,
    events,
    calibrateConcurrency,
    calibrationWarnings,
    signal,
  );
  throwIfAborted(signal);

  events.onStep?.(`Aggregating graph`);
  const { graph, warnings: aggregateWarnings }: AggregateResult = aggregate({
    rootRequest: options.rootRequest,
    scope: options.scope,
    workspaceRoot: options.workspaceRoot,
    analyses,
    callees,
  });

  const stats: OrchestratorStats = {
    filesScanned: files.length,
    filesAnalyzed: analyses.length,
    filesFailed: failures.length,
    methodsCalibrated: callees.size,
    methodsFailed: countCalibrationFailures(calibrationWarnings),
    classCount: Object.keys(graph.classes).length,
    methodCount: Object.keys(graph.methods).length,
    methodEdgeCount: graph.methodEdges.length,
    classEdgeCount: graph.classEdges.length,
    durationMs: Date.now() - t0,
  };

  return {
    graph,
    stats,
    warnings: [...aggregateWarnings, ...calibrationWarnings],
    failures,
  };
}

// -------------------------------------------------------------------------
//   per-file LLM fan-out
// -------------------------------------------------------------------------

async function analyzeAll(
  files: readonly string[],
  deps: OrchestratorDeps,
  events: OrchestratorEvents,
  concurrency: number,
  signal: AbortSignal | undefined,
): Promise<{ analyses: AnalyzeResult[]; failures: { file: string; error: Error }[] }> {
  const analyses: AnalyzeResult[] = [];
  const failures: { file: string; error: Error }[] = [];

  await runBounded(files, concurrency, async (file) => {
    throwIfAborted(signal);
    try {
      const text = await deps.reader.readText(file);
      if (text === undefined) {
        events.onFileAnalyzed?.({ file, classes: 0, methods: 0, error: new Error('file missing') });
        return;
      }
      const input: AnalyzeInput = {
        filePath: file,
        fileText: text,
        languageId: languageIdFromFile(file),
        signal,
      };
      const result = await analyzeFile(input, deps.llm);
      analyses.push(result);
      events.onFileAnalyzed?.({ file, classes: result.classes.length, methods: result.methods.length });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      failures.push({ file, error: err });
      events.onFileAnalyzed?.({ file, classes: 0, methods: 0, error: err });
    }
  });

  return { analyses, failures };
}

// -------------------------------------------------------------------------
//   per-method calibrator fan-out
// -------------------------------------------------------------------------

interface CalibrationJob {
  methodId: string;
  params: ResolveCalleesParams;
  languageId: string;
}

async function calibrateAll(
  analyses: readonly AnalyzeResult[],
  deps: OrchestratorDeps,
  events: OrchestratorEvents,
  concurrency: number,
  warnings: string[],
  signal: AbortSignal | undefined,
): Promise<Map<string, Callee[]>> {
  const callees = new Map<string, Callee[]>();
  if (!deps.calibratorFor) return callees;

  const jobs: CalibrationJob[] = [];
  for (const a of analyses) {
    const languageId = languageIdFromFile(a.filePath);
    for (const m of a.methods) {
      jobs.push({
        methodId: m.id,
        languageId,
        params: {
          filePath: a.filePath,
          line: m.line,
          classId: m.ownerClassId,
          methodName: m.name,
        },
      });
    }
  }

  await runBounded(jobs, concurrency, async (job) => {
    throwIfAborted(signal);
    const calibrator = deps.calibratorFor!(job.languageId);
    if (!calibrator) return;
    try {
      const res = await calibrator.resolveCallees(job.params);
      callees.set(job.methodId, res.callees);
      events.onMethodCalibrated?.({ methodId: job.methodId, callees: res.callees.length });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      warnings.push(`calibrator failed for ${job.methodId}: ${err.message}`);
      events.onMethodCalibrated?.({ methodId: job.methodId, callees: 0, error: err });
    }
  });

  return callees;
}

function countCalibrationFailures(warnings: readonly string[]): number {
  let n = 0;
  for (const w of warnings) {
    if (w.startsWith('calibrator failed for ')) n++;
  }
  return n;
}

// -------------------------------------------------------------------------
//   misc
// -------------------------------------------------------------------------

async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const cap = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  const runOne = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: cap }, runOne));
}

function languageIdFromFile(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith('.cs')) return 'csharp';
  if (lower.endsWith('.tsx')) return 'typescriptreact';
  if (lower.endsWith('.ts')) return 'typescript';
  if (lower.endsWith('.jsx')) return 'javascriptreact';
  if (lower.endsWith('.js')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  return 'plaintext';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    throw reason instanceof Error ? reason : new Error('orchestrator aborted');
  }
}

function emptyResult(options: OrchestratorOptions, t0: number): OrchestratorResult {
  const graph: CodeMapGraph = {
    schemaVersion: 2,
    rootRequest: options.rootRequest,
    scope: options.scope,
    workspaceRoot: options.workspaceRoot,
    boundedContexts: [],
    classes: {},
    methods: {},
    externalDeps: {},
    methodEdges: [],
    classEdges: [],
    entryMethodIds: [],
    readingOrder: [],
  };
  return {
    graph,
    stats: {
      filesScanned: 0,
      filesAnalyzed: 0,
      filesFailed: 0,
      methodsCalibrated: 0,
      methodsFailed: 0,
      classCount: 0,
      methodCount: 0,
      methodEdgeCount: 0,
      classEdgeCount: 0,
      durationMs: Date.now() - t0,
    },
    warnings: [],
    failures: [],
  };
}
