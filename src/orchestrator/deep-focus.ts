import type { CancellationToken } from 'vscode';
import { AnalyzerCache } from '../persistence/analyzer-cache';
import { PROMPT_VERSION } from '../llm/prompts';
import { CALIBRATOR_VERSION } from '../calibration/calibrator';
import { hydrateDocComments } from './doc-extractor';
import { classify } from './bc-classifier';
import { computeReadingOrder } from '../graph/reading-order';
import { SingleFileAnalyzer, type AnalyzeResult } from './single-file-analyzer';
import type { FileReader } from './workspace-scanner';
import type { SymbolProvider } from '../calibration/symbol-provider';
import type { LlmClient } from '../llm/client';
import type { CodeMapGraph, CodeNode, CodeEdge } from '../shared/types';

/**
 * Deep-focus — re-runs the single-file analyzer on the file that defines a
 * class that the current graph only knows as an external dep (or as an
 * unverified ghost), then merges the new analyzer output back into the
 * stored graph so the user can read it as a fully-verified node.
 *
 * Distinct from {@link focusSubgraph}, which is a pure filter over an
 * already-analyzed graph. Deep-focus actually expands coverage; that's why
 * it lives in `orchestrator/` next to the LLM-driven analyzer rather than
 * in `chat/`.
 *
 * Cost / safety:
 *  - Exactly one LLM call when the file isn't cached (typical: a few
 *    seconds; comparable to one entry in a normal `generate codemap` run).
 *  - Zero LLM cost when the file is in the analyzer cache (same key as the
 *    main pipeline: PROMPT_VERSION + CALIBRATOR_VERSION + file + text).
 *  - Bounded: only analyzes the single file that defines the target class.
 *    No transitive expansion. If the user wants to keep zooming, they re-
 *    issue `/focus` on the next class.
 */

export interface DeepFocusDeps {
  reader: FileReader;
  symbols: SymbolProvider;
  llm: LlmClient;
  cache?: AnalyzerCache;
}

export type DeepFocusFailureReason =
  | 'symbol_not_found'
  | 'file_not_found'
  | 'no_nodes_emitted';

export interface DeepFocusSuccess {
  ok: true;
  graph: CodeMapGraph;
  /** File that was analyzed (workspace-relative). */
  file: string;
  /** Class ids the analyzer freshly emitted (or upgraded). */
  upgradedIds: string[];
  /** True if the analyzer result was served from the cache. */
  fromCache: boolean;
}

export interface DeepFocusFailure {
  ok: false;
  reason: DeepFocusFailureReason;
  detail?: string;
}

export type DeepFocusResult = DeepFocusSuccess | DeepFocusFailure;

export interface DeepFocusInput {
  targetClass: string;
  baseGraph: CodeMapGraph;
  deps: DeepFocusDeps;
  token: CancellationToken;
}

/**
 * Returns true when the user issuing `/focus <Class>` would benefit from a
 * deep analysis — i.e. the target is currently not a fully-analyzed node in
 * the base graph. Used by the chat layer to decide between `focusSubgraph`
 * (cheap) and `runDeepFocus` (LLM call).
 */
export function shouldDeepFocus(graph: CodeMapGraph, target: string): boolean {
  if (!target) return false;
  const direct = graph.nodes[target];
  if (!direct) {
    // Anything in externalDeps (ext: prefix or bare name) is by definition
    // not a full node yet — that's exactly the case where deep-focus helps.
    return graph.externalDeps.some(d => d.name === target);
  }
  // Already in nodes but unverified / no methods → still worth expanding.
  if (direct.verification !== 'verified') return true;
  if (!direct.methods || direct.methods.length === 0) return true;
  return false;
}

export async function runDeepFocus(input: DeepFocusInput): Promise<DeepFocusResult> {
  const { targetClass, baseGraph, deps, token } = input;

  // ---- 1. Locate the file that defines the target class. -----------------
  const hits = await deps.symbols.findInWorkspace(targetClass, 10);
  if (token.isCancellationRequested) return { ok: false, reason: 'symbol_not_found', detail: 'cancelled' };
  // Prefer Class / Interface / Record / Struct kinds; fall back to first hit.
  const classKinds = new Set(['Class', 'Interface', 'Struct', 'Enum']);
  const exact = hits.filter(h => h.name === targetClass);
  const pool = exact.length > 0 ? exact : hits;
  const best = pool.find(h => classKinds.has(h.kind)) ?? pool[0];
  if (!best) {
    return { ok: false, reason: 'symbol_not_found' };
  }

  // ---- 2. Read the file. -------------------------------------------------
  const fileText = await deps.reader.readText(best.file);
  if (fileText === undefined) {
    return { ok: false, reason: 'file_not_found', detail: best.file };
  }

  // ---- 3. Cache lookup. Same key as the main pipeline so a file analyzed
  //         during the original `generate` run is reused for free here. ----
  const cacheKey = deps.cache
    ? AnalyzerCache.key(`${PROMPT_VERSION}/${CALIBRATOR_VERSION}`, best.file, fileText)
    : '';
  let analysis: AnalyzeResult | undefined = deps.cache?.get(cacheKey);
  let fromCache = !!analysis;
  if (analysis) {
    hydrateDocComments(analysis.nodes, analysis.file, fileText);
  } else {
    const bucket = classify(best.file).boundedContext;
    const analyzer = new SingleFileAnalyzer(deps.llm, deps.symbols);
    analysis = await analyzer.analyze({
      file: best.file,
      fileText,
      boundedContext: bucket,
      token,
    });
    if (token.isCancellationRequested) return { ok: false, reason: 'no_nodes_emitted', detail: 'cancelled' };
    if (deps.cache && cacheKey) void deps.cache.set(cacheKey, analysis);
  }
  if (!analysis || analysis.nodes.length === 0) {
    return { ok: false, reason: 'no_nodes_emitted', detail: best.file };
  }

  // ---- 4. Merge into the base graph. -------------------------------------
  const merged = mergeAnalysisIntoGraph(baseGraph, analysis);
  return {
    ok: true,
    graph: merged.graph,
    file: best.file,
    upgradedIds: merged.upgradedIds,
    fromCache,
  };
}

/**
 * Merges a single AnalyzeResult into an existing graph. Distinct from the
 * full `aggregate()` step which assumes a fresh batch of analyses; this
 * fills the narrower "I have a base graph + one more file" niche.
 *
 * Merge rules:
 *  - New node id: insert.
 *  - Existing node id: replace if the base copy was ghosty (verification ≠
 *    verified OR no methods) and the new copy is healthier. Otherwise the
 *    base wins (the original analysis was richer; don't undo aggregator
 *    work like namespace disambiguation).
 *  - Edges: dedupe by (from, to, kind). If a base `external_calls` edge
 *    pointed at `ext:Target` and Target is now an internal node, rewrite
 *    the edge to a real `calls` edge so the graph shows the new
 *    connection.
 *  - externalDeps: drop entries that just became internal nodes.
 */
function mergeAnalysisIntoGraph(
  base: CodeMapGraph,
  analysis: AnalyzeResult,
): { graph: CodeMapGraph; upgradedIds: string[] } {
  const upgradedIds: string[] = [];
  const nodes: Record<string, CodeNode> = { ...base.nodes };

  for (const n of analysis.nodes) {
    const existing = nodes[n.id];
    const baseGhosty =
      !existing ||
      existing.verification !== 'verified' ||
      !existing.methods ||
      existing.methods.length === 0;
    if (!existing || (baseGhosty && n.verification === 'verified')) {
      nodes[n.id] = n;
      upgradedIds.push(n.id);
    }
  }

  // Promote ext:<id> edges to calls edges when <id> is now an internal node.
  const newInternalIds = new Set(upgradedIds);
  const edgeKey = (e: CodeEdge): string => `${e.from}\0${e.to}\0${e.kind}`;
  const seen = new Set<string>();
  const edges: CodeEdge[] = [];
  for (const e of base.edges) {
    let promoted = e;
    if (e.kind === 'external_calls' && e.to.startsWith('ext:')) {
      const bare = e.to.slice(4);
      if (newInternalIds.has(bare) || nodes[bare]) {
        promoted = { ...e, kind: 'calls', to: bare };
      }
    }
    const k = edgeKey(promoted);
    if (!seen.has(k)) {
      seen.add(k);
      edges.push(promoted);
    }
  }
  for (const e of analysis.edges) {
    const k = edgeKey(e);
    if (!seen.has(k)) {
      seen.add(k);
      edges.push(e);
    }
  }

  // Drop externalDeps that just became internal.
  let externalDeps = base.externalDeps.filter(d => !nodes[d.name]);
  // Ensure every `ext:<Name>` edge target referenced by the merged graph
  // has a matching entry in externalDeps. Without this the webview renderer
  // (cytoscape) refuses to create the edge ("non-existent target") and the
  // whole graph fails to render. analysis edges may introduce new
  // dependencies the base graph never saw.
  const knownDepNames = new Set(externalDeps.map(d => d.name));
  for (const e of edges) {
    if (!e.to.startsWith('ext:')) continue;
    const bare = e.to.slice(4);
    if (!knownDepNames.has(bare) && !nodes[bare]) {
      externalDeps = [...externalDeps, { name: bare, kind: 'package' }];
      knownDepNames.add(bare);
    }
  }

  const graph: CodeMapGraph = {
    ...base,
    nodes,
    edges,
    externalDeps,
  };
  graph.readingOrder = computeReadingOrder(graph);
  return { graph, upgradedIds };
}
