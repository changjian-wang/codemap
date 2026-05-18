import type * as vscode from 'vscode';
import type { CodeMapGraph } from '../shared/types';
import type { FileReader } from './workspace-scanner';
import type { SymbolProvider } from '../calibration/symbol-provider';
import type { LlmClient } from '../llm/client';
import { scanWorkspace, type ScanOptions, DEFAULT_SCAN_OPTIONS } from './workspace-scanner';
import { bucketAll } from './bc-classifier';
import { SingleFileAnalyzer, type AnalyzeResult } from './single-file-analyzer';
import { runParallel } from './parallel-runner';
import { aggregate } from './aggregator';

/**
 * End-to-end orchestrator: chat request → final {@link CodeMapGraph}.
 *
 *   1. WorkspaceScanner picks the skeleton (≤ N files via BFS from entries)
 *   2. bc-classifier assigns each file a bounded context
 *   3. ParallelRunner fans out one analyzer per file (concurrency ≤ M)
 *   4. Aggregator merges per-file outputs, resolves cross-file edges
 *
 * The orchestrator is constructor-injected with its dependencies (FileReader,
 * SymbolProvider, LlmClient) so we can unit-test the wiring without spinning
 * up the vscode runtime. The actual VS Code adapters live in
 * extension.ts (file reader, symbol provider, llm client).
 *
 * Progress is reported via the {@link OrchestratorEvents} callbacks. The
 * chat participant uses them to stream action-trace lines into the chat
 * thread; the webview is updated once at the end with the final graph.
 */

export interface OrchestratorDeps {
  reader: FileReader;
  symbols: SymbolProvider;
  llm: LlmClient;
}

export interface OrchestratorOptions {
  rootRequest: string;
  scope: string;
  /** Optional substring filter on relative paths (e.g. `/scope apps/api/src/Capture`). */
  scopePrefix?: string;
  scan?: Partial<ScanOptions>;
  maxParallelAnalyzers?: number;
}

export interface OrchestratorEvents {
  onStep?: (step: string) => void;
  onSkeleton?: (info: { entryPoints: string[]; skeleton: string[]; overflow: string[] }) => void;
  onFileDone?: (info: { file: string; result?: AnalyzeResult; error?: Error; doneCount: number; total: number }) => void;
  onWarning?: (msg: string) => void;
}

export interface OrchestratorResult {
  graph: CodeMapGraph;
  stats: {
    filesScanned: number;
    filesAnalyzed: number;
    filesFailed: number;
    nodeCount: number;
    edgeCount: number;
    verifiedCount: number;
    partialCount: number;
    unverifiedCount: number;
    lspNotReadyCount: number;
    durationMs: number;
  };
  warnings: string[];
}

export async function runOrchestrator(
  deps: OrchestratorDeps,
  options: OrchestratorOptions,
  events: OrchestratorEvents,
  token: vscode.CancellationToken,
): Promise<OrchestratorResult> {
  const t0 = Date.now();
  const scanOptions: ScanOptions = { ...DEFAULT_SCAN_OPTIONS, ...options.scan };
  const concurrency = options.maxParallelAnalyzers ?? 6;

  // ---- Step 1: scan ----
  events.onStep?.(`Scanning workspace (max ${scanOptions.maxFiles} files, depth ${scanOptions.maxDepth})`);
  const scan = await scanWorkspace(deps.reader, scanOptions);
  if (token.isCancellationRequested) throw new CancelledError();

  let skeleton = scan.skeleton;
  if (options.scopePrefix) {
    const prefix = options.scopePrefix.replace(/\\/g, '/');
    skeleton = skeleton.filter(f => f.startsWith(prefix));
  }
  events.onSkeleton?.({
    entryPoints: scan.entryPoints,
    skeleton,
    overflow: scan.overflow,
  });

  if (skeleton.length === 0) {
    throw new Error(
      'No analyzable entry points found in the workspace. ' +
        'CodeMap looks for Program.cs / *Endpoints.cs / index.ts and friends.',
    );
  }

  // ---- Step 2: classify ----
  events.onStep?.(`Classifying ${skeleton.length} files into bounded contexts`);
  const classified = bucketAll(skeleton);
  if (token.isCancellationRequested) throw new CancelledError();

  // ---- Step 2.5: warm up the language server ----
  // Languages like C# (especially with C# Dev Kit) take seconds-to-minutes to
  // index a workspace. If we hit symbolsInFile before that, every analyzer
  // gets `undefined` and every node ends up lspNotReady. We poll the first
  // entry point until either we get symbols or we hit the timeout, so the
  // bulk of the run sees a hot server.
  events.onStep?.('Warming up language server');
  const warmupTarget = scan.entryPoints[0] ?? skeleton[0]!;
  const warmupReady = await warmupLsp(deps.symbols, warmupTarget, token);
  if (!warmupReady) {
    events.onWarning?.(
      'Language server did not produce symbols within the warmup window. ' +
        'Verification scores may be unreliable on this run; re-run after the ' +
        'workspace finishes indexing.',
    );
  }
  if (token.isCancellationRequested) throw new CancelledError();

  // ---- Step 3: analyze in parallel ----
  events.onStep?.(`Analyzing ${skeleton.length} files via vscode.lm (≤ ${concurrency} concurrent)`);
  const analyzer = new SingleFileAnalyzer(deps.llm, deps.symbols);
  let doneCount = 0;
  const total = classified.length;

  const poolResults = await runParallel(
    classified,
    async ({ file, bucket }) => {
      if (token.isCancellationRequested) throw new CancelledError();
      const fileText = await deps.reader.readText(file);
      if (fileText === undefined) throw new Error(`could not read ${file}`);
      const result = await analyzer.analyze({
        file,
        fileText,
        boundedContext: bucket,
        token,
      });
      doneCount++;
      events.onFileDone?.({ file, result, doneCount, total });
      return result;
    },
    concurrency,
  );
  if (token.isCancellationRequested) throw new CancelledError();

  const analyses: AnalyzeResult[] = [];
  let filesFailed = 0;
  for (let i = 0; i < poolResults.length; i++) {
    const r = poolResults[i]!;
    if (r.value) {
      analyses.push(r.value);
    } else if (r.error) {
      filesFailed++;
      events.onFileDone?.({
        file: classified[i]!.file,
        error: r.error,
        doneCount: ++doneCount,
        total,
      });
    }
  }

  // ---- Step 4: aggregate ----
  events.onStep?.(`Aggregating ${analyses.length} per-file graphs`);
  const agg = await aggregate({
    rootRequest: options.rootRequest,
    scope: options.scope,
    analyses,
    symbols: deps.symbols,
  });
  for (const w of agg.warnings) events.onWarning?.(w);

  const nodes = Object.values(agg.graph.nodes);
  const verifiedCount = nodes.filter(n => n.verification === 'verified').length;
  const partialCount = nodes.filter(n => n.verification === 'partial').length;
  const unverifiedCount = nodes.filter(n => n.verification === 'unverified').length;
  const lspNotReadyCount = nodes.filter(n => n.verificationDetails?.lspNotReady).length;
  if (lspNotReadyCount > 0) {
    events.onWarning?.(
      `${lspNotReadyCount} of ${nodes.length} nodes could not be calibrated against the language server. ` +
        `Their verification state is provisional; re-run after the workspace finishes indexing.`,
    );
  }

  return {
    graph: agg.graph,
    stats: {
      filesScanned: scan.skeleton.length,
      filesAnalyzed: analyses.length,
      filesFailed,
      nodeCount: nodes.length,
      edgeCount: agg.graph.edges.length,
      verifiedCount,
      partialCount,
      unverifiedCount,
      lspNotReadyCount,
      durationMs: Date.now() - t0,
    },
    warnings: agg.warnings,
  };
}

/**
 * Warmup: poll the symbol provider for the given target file until either we
 * see a non-undefined result or the timeout elapses. We treat `[]` as ready
 * too (the file might really have no symbols).
 */
async function warmupLsp(
  symbols: { symbolsInFile: (f: string) => Promise<unknown> },
  target: string,
  token: vscode.CancellationToken,
  timeoutMs = 8000,
  pollMs = 400,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (token.isCancellationRequested) return false;
    const out = await symbols.symbolsInFile(target);
    if (out !== undefined) return true;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

export class CancelledError extends Error {
  constructor() {
    super('CodeMap analysis was cancelled.');
    this.name = 'CancelledError';
  }
}
