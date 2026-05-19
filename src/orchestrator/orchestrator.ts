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
import type { AnalyzerCache } from '../persistence/analyzer-cache';
import { AnalyzerCache as AnalyzerCacheClass } from '../persistence/analyzer-cache';
import { PROMPT_VERSION } from '../llm/prompts';
import { CALIBRATOR_VERSION } from '../calibration/calibrator';
import { hydrateDocComments } from './doc-extractor';

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
  /** Optional cache for per-file analyzer results. When omitted, every file is re-analyzed. */
  cache?: AnalyzerCache;
}

export interface OrchestratorOptions {
  rootRequest: string;
  scope: string;
  /** Optional substring filter on relative paths (e.g. `/scope apps/api/src/Capture`). */
  scopePrefix?: string;
  scan?: Partial<ScanOptions>;
  maxParallelAnalyzers?: number;
  /**
   * Upper bound on how long the orchestrator waits for the language server
   * to produce symbols before kicking off analysis. Default 30s—covers a
   * cold C# Dev Kit start. Bump higher on very large solutions.
   */
  lspWarmupTimeoutMs?: number;
}

export interface OrchestratorEvents {
  onStep?: (step: string) => void;
  onSkeleton?: (info: { entryPoints: string[]; skeleton: string[]; overflow: string[] }) => void;
  onFileDone?: (info: { file: string; result?: AnalyzeResult; error?: Error; doneCount: number; total: number; cached?: boolean }) => void;
  onWarning?: (msg: string) => void;
}

export interface OrchestratorResult {
  graph: CodeMapGraph;
  stats: {
    filesScanned: number;
    filesAnalyzed: number;
    filesFailed: number;
    filesFromCache: number;
    nodeCount: number;
    edgeCount: number;
    verifiedCount: number;
    partialCount: number;
    unverifiedCount: number;
    lspNotReadyCount: number;
    /** Wall-clock spent waiting for the language server to produce its first non-empty symbol list. */
    warmupMs: number;
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
  const scopePrefix = options.scopePrefix?.replace(/\\/g, '/').replace(/\/+$/, '');
  const scanOptions: ScanOptions = {
    ...DEFAULT_SCAN_OPTIONS,
    // Production code path: rank skeleton by graph centrality, not raw BFS
    // order. Tests opt back into `'bfs'` via `options.scan` for determinism.
    rankBy: 'centrality',
    // Production code path: if BFS can't expand (C# `using` is a namespace,
    // not a path; Python absolute imports are external), fall back to
    // filling the skeleton with the remaining eligible files so a .NET
    // solution doesn't get analyzed as "just the 5 entry points".
    fillToMaxFiles: true,
    ...options.scan,
    ...(scopePrefix ? { pathPrefix: scopePrefix } : {}),
  };
  const concurrency = options.maxParallelAnalyzers ?? 6;

  // ---- Step 1: scan ----
  events.onStep?.(`Scanning workspace (max ${scanOptions.maxFiles} files, depth ${scanOptions.maxDepth})`);
  const scan = await scanWorkspace(deps.reader, scanOptions);
  if (token.isCancellationRequested) throw new CancelledError();

  const skeleton = scan.skeleton;
  events.onSkeleton?.({
    entryPoints: scan.entryPoints,
    skeleton,
    overflow: scan.overflow,
  });

  if (skeleton.length === 0) {
    // Distinguish "scope killed all candidates" from "wrong language" from
    // "no entry point matched". The first two have actionable user fixes.
    const extList = scanOptions.extensions.join('/');
    if (scopePrefix) {
      throw new Error(
        `Scope '${scopePrefix}' contained no analyzable ${extList} ` +
          `files. Check the path (workspace-relative, forward slashes ok) or ` +
          `drop /scope to analyze the whole workspace.`,
      );
    }
    const sawAnyFile = scan.entryPoints.length + scan.overflow.length > 0;
    if (!sawAnyFile) {
      throw new Error(
        `No supported source files found. CodeMap currently analyzes ` +
          `${extList} only — other languages need WorkspaceScanner.extensions extended.`,
      );
    }
    throw new Error(
      'No analyzable entry points found in the workspace. ' +
        'CodeMap looks for Program.cs / *Endpoints.cs / index.ts and friends.',
    );
  }

  // ---- Step 2: classify ----
  events.onStep?.(`Classifying ${skeleton.length} files into bounded contexts`);
  const classified = bucketAll(skeleton);
  if (token.isCancellationRequested) throw new CancelledError();

  // ---- Step 2.5: pre-read file texts + predict cache coverage ----
  //
  // Reading every skeleton file in parallel is cheap (~50ms for 80 .cs
  // files). The payoff: we can compute the cache hit rate BEFORE deciding
  // whether to warm up the language server. C# Dev Kit cold-starts in 30s
  // even on a small solution; if every file is already cached, the LSP
  // never gets touched and waiting on warmup is pure friction.
  //
  // Side benefit: each worker reuses the pre-read text instead of
  // re-reading from disk.
  events.onStep?.(`Pre-reading ${skeleton.length} files and probing cache`);
  interface PrecheckEntry {
    text: string;
    cacheKey: string;
    cached: AnalyzeResult | undefined;
  }
  const preCheck = new Map<string, PrecheckEntry>();
  await Promise.all(
    skeleton.map(async file => {
      const text = await deps.reader.readText(file);
      if (text === undefined) return;
      const cacheKey = deps.cache
        ? AnalyzerCacheClass.key(
            `${PROMPT_VERSION}/${CALIBRATOR_VERSION}`,
            file,
            text,
          )
        : '';
      const cached = deps.cache?.get(cacheKey);
      preCheck.set(file, { text, cacheKey, cached });
    }),
  );
  if (token.isCancellationRequested) throw new CancelledError();
  const cacheMissCount = Array.from(preCheck.values()).filter(p => !p.cached).length;

  // ---- Step 2.6: warm up the language server (skip when fully cached) ----
  // Languages like C# (especially with C# Dev Kit) take seconds-to-minutes to
  // index a workspace. If we hit symbolsInFile before that, every analyzer
  // gets `undefined` and every node ends up lspNotReady. We poll multiple
  // entry points until at least one returns a non-empty symbol list—C# Dev
  // Kit famously returns `[]` for a few seconds during indexing, so an
  // empty response is not a proof of readiness.
  //
  // When cacheMissCount === 0, no analyzer worker will need the LSP at all
  // (every file is served from cache). Warmup is pure latency in that case;
  // skip it.
  let warmupMs = 0;
  if (cacheMissCount === 0 && preCheck.size > 0) {
    events.onStep?.('All files cached — skipping LSP warmup');
  } else {
    events.onStep?.('Warming up language server');
    const warmupTargets = (scan.entryPoints.length > 0 ? scan.entryPoints : skeleton).slice(0, 3);
    const warmupT0 = Date.now();
    const warmupReady = await warmupLsp(deps.symbols, warmupTargets, token, {
      timeoutMs: options.lspWarmupTimeoutMs ?? 30_000,
    });
    warmupMs = Date.now() - warmupT0;
    if (!warmupReady) {
      events.onWarning?.(
        `Language server did not produce symbols within the warmup window (${Math.round(warmupMs / 1000)}s). ` +
          'Verification scores may be unreliable on this run; re-run after the ' +
          'workspace finishes indexing.',
      );
    }
  }
  if (token.isCancellationRequested) throw new CancelledError();

  // ---- Step 3: analyze in parallel (with optional cache) ----
  events.onStep?.(`Analyzing ${skeleton.length} files via vscode.lm (≤ ${concurrency} concurrent)`);
  const analyzer = new SingleFileAnalyzer(deps.llm, deps.symbols);
  let doneCount = 0;
  let filesFromCache = 0;
  const total = classified.length;

  const poolResults = await runParallel(
    classified,
    async ({ file, bucket }) => {
      if (token.isCancellationRequested) throw new CancelledError();
      const pre = preCheck.get(file);
      const fileText = pre?.text ?? (await deps.reader.readText(file));
      if (fileText === undefined) throw new Error(`could not read ${file}`);

      // ---- Cache lookup ----
      // The cache is keyed on (PROMPT_VERSION, CALIBRATOR_VERSION, file,
      // fileText) so:
      //  - bumping PROMPT_VERSION invalidates everything,
      //  - bumping CALIBRATOR_VERSION invalidates everything (calibration
      //    verdict is baked into the cached AnalyzeResult),
      //  - editing the file invalidates that file,
      //  - renaming the file invalidates because file path is part of key.
      //
      // The pre-check phase already populated `pre.cached` for files we
      // know about; the lookup here is the fallback for newly-discovered
      // files (shouldn't happen — skeleton is fixed before pre-check —
      // but defended for safety).
      const cacheKey =
        pre?.cacheKey ??
        (deps.cache
          ? AnalyzerCacheClass.key(
              `${PROMPT_VERSION}/${CALIBRATOR_VERSION}`,
              file,
              fileText,
            )
          : '');
      const cached = pre?.cached ?? deps.cache?.get(cacheKey);
      if (cached) {
        // Older cache entries pre-date docComment extraction. Re-running
        // the extractor is purely a string operation; cheap enough to do on
        // every hit so users see verbatim source comments even without an
        // LLM call. Mutates the cached object in place; that's fine — the
        // cache stores references and the next read will see the same enrichment.
        hydrateDocComments(cached.nodes, cached.file, fileText);
        doneCount++;
        filesFromCache++;
        events.onFileDone?.({ file, result: cached, doneCount, total, cached: true });
        return cached;
      }

      const result = await analyzer.analyze({
        file,
        fileText,
        boundedContext: bucket,
        token,
      });
      if (deps.cache && cacheKey) {
        // Fire-and-forget the write; the cache itself dedupes pending writes.
        void deps.cache.set(cacheKey, result);
      }
      doneCount++;
      events.onFileDone?.({ file, result, doneCount, total, cached: false });
      return result;
    },
    concurrency,
    {
      adaptiveBackoff: { failureThreshold: 3, cooldownMs: 1500 },
      onBackoff: (n) =>
        events.onWarning?.(
          `${n} consecutive analyzer failures — slowing down remaining requests to avoid rate-limit cascade.`,
        ),
    },
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
      filesFromCache,
      nodeCount: nodes.length,
      edgeCount: agg.graph.edges.length,
      verifiedCount,
      partialCount,
      unverifiedCount,
      lspNotReadyCount,
      warmupMs,
      durationMs: Date.now() - t0,
    },
    warnings: agg.warnings,
  };
}

/**
 * Warmup: poll the symbol provider for a small list of target files until
 * one of them returns a NON-EMPTY symbol array, or the timeout elapses.
 *
 * Why non-empty matters: a cold C# Dev Kit responds with `[]` for several
 * seconds during indexing. The previous implementation treated that as
 * "ready" and the bulk of the run then went through the calibrator with
 * still-empty symbol lists, marking every node unverified. We now require
 * proof-of-life: at least one entry file must report at least one symbol.
 *
 * `undefined` means the LSP itself didn't respond (still booting). We keep
 * polling. If the deadline passes without seeing any non-empty result we
 * return false and the orchestrator emits the lspNotReady warning so the
 * user knows verification scores are provisional.
 */
export interface WarmupOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export async function warmupLsp(
  symbols: { symbolsInFile: (f: string) => Promise<{ length?: number } | undefined | null> },
  targets: string[] | string,
  token: vscode.CancellationToken,
  opts: WarmupOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 400;
  const targetList = (Array.isArray(targets) ? targets : [targets]).slice(0, 5);
  if (targetList.length === 0) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (token.isCancellationRequested) return false;
    for (const target of targetList) {
      const out = await symbols.symbolsInFile(target);
      // Ready iff LSP returned an actual array with at least one symbol.
      // `undefined` = still booting. `[]` = LSP responded but produced no
      // symbols (C# Dev Kit does this during indexing).
      if (out && typeof out === 'object' && (out.length ?? 0) > 0) return true;
      if (token.isCancellationRequested) return false;
    }
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
