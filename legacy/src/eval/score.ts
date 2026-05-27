import type { CodeMapGraph } from '../shared/types';

/**
 * Golden sample for eval scoring.
 *
 * A golden defines what an analyzer "should" emit for a specific scope of a
 * specific workspace. It is hand-authored — usually 6-10 classes covering
 * the main bounded contexts — and lives in `.codemap/golden.json` in the
 * target workspace (or anywhere the user wants, via the
 * `codemap.devGoldenPath` setting).
 *
 * The scoring is strict-overlap, not soft-match:
 *   nodes precision = |actual ∩ expected| / |actual filtered to scope|
 *   nodes recall    = |actual ∩ expected| / |expected|
 *   edges precision = same, on (from, to) keys
 *   edges recall    = same
 *
 * `scopeFiles` lets the golden cover only a subset of the workspace —
 * before scoring we filter the actual graph to nodes whose `file` matches
 * one of these prefixes, so a 6-class golden does not get penalised when
 * the orchestrator picks 17 files. Leaving it empty means "score against
 * the entire actual graph".
 */
export interface GoldenSample {
  name: string;
  description?: string;
  /** Optional file-path prefixes that scope what is being evaluated. */
  scopeFiles?: string[];
  /** Expected class node ids. */
  nodes: string[];
  /** Expected calls/external_calls edges (kind defaults to 'calls'). */
  edges: { from: string; to: string; kind?: 'calls' | 'external_calls' }[];
  /**
   * Edge-target prefixes to ignore on BOTH sides (expected and actual)
   * before scoring. Use for BCL / common infra noise that is not a useful
   * "business dependency" signal in a codemap, e.g. `ext:System.`,
   * `ext:File`, `ext:Dapper`. A prefix matches when the edge's `to` field
   * starts with the prefix string. Empty / missing means "score everything".
   */
  ignoreEdgeToPrefixes?: string[];
}

export interface EvalScore {
  precision: number;
  recall: number;
  f1: number;
}

export interface ScoreResult {
  nodes: EvalScore;
  edges: EvalScore;
  /** Concrete diff so the user / chat handler can explain the numbers. */
  diff: {
    missingNodes: string[];
    extraNodes: string[];
    missingEdges: { from: string; to: string }[];
    extraEdges: { from: string; to: string }[];
  };
}

function f1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function ratio(num: number, denom: number): number {
  return denom === 0 ? 0 : num / denom;
}

function inScope(file: string, scopeFiles: string[] | undefined): boolean {
  if (!scopeFiles || scopeFiles.length === 0) return true;
  return scopeFiles.some(s => file.startsWith(s));
}

/**
 * Build a canonical-form map for `ext:` edge targets so bare and
 * fully-qualified spellings of the same external symbol collapse to one
 * key before set intersection.
 *
 * Two collapses are performed:
 *
 * 1. **`ext:` → in-graph node** (v0.0.8). If the workspace owns a node
 *    whose id equals the bare form (or the last dot-segment of the FQN)
 *    of an `ext:` target, collapse the `ext:` form onto that node id.
 *    Motivation: the aggregator now promotes `ext:Foo → calls Foo` when
 *    it can resolve the symbol via LSP, so an older baseline with
 *    `ext:Foo` and a newer run with bare `Foo` would otherwise be
 *    double-counted as "one missing + one extra" against the same
 *    logical edge.
 *
 * 2. **bare ↔ FQN aliasing inside `ext:`** (v0.0.7). The LLM sometimes
 *    emits bare `ext:AssemblyMarker` while the golden carries the
 *    namespace-qualified `ext:Lumen.Modules.Capture.AssemblyMarker` (or
 *    vice versa). Targets share a bucket iff they have the same final
 *    dot-separated segment AND at least one side has no dots. The
 *    longest form in the union (golden ∪ actual, post
 *    `ignoreEdgeToPrefixes` filter) wins as the canonical spelling;
 *    ties break lexicographically for determinism.
 *
 * Non-`ext:` targets pass through untouched.
 *
 * Known limitations:
 * - If two distinct namespaces legitimately export the same type name
 *   (e.g. golden has both `ext:Foo.Marker` and `ext:Bar.Marker` and
 *   actual has bare `ext:Marker`), the bare form collapses arbitrarily
 *   onto whichever FQN sorts first.
 * - If a true external dep shares its short name with a workspace
 *   class, pass-1 collapse will mis-merge them. This mirrors the
 *   ambiguity the aggregator's own LSP-promotion path accepts; in
 *   practice we treat workspace ownership as the stronger signal.
 */
function buildExtCanonicalMap(
  targets: Iterable<string>,
  knownNodeIds: Set<string>,
): Map<string, string> {
  const exts = new Set<string>();
  for (const t of targets) {
    if (t.startsWith('ext:')) exts.add(t);
  }
  const result = new Map<string, string>();

  // Pass 1: `ext:X` collapses onto an in-graph node id when X (or X's
  // last dot-segment) matches. Skip targets that are already non-`ext:`
  // — those would only land here if the caller passed nodes prefixed
  // with `ext:`, which workspace ids never are.
  const collapsedToNode = new Set<string>();
  for (const t of exts) {
    const bare = t.slice(4);
    if (knownNodeIds.has(bare)) {
      result.set(t, bare);
      collapsedToNode.add(t);
      continue;
    }
    if (bare.includes('.')) {
      const last = bare.split('.').pop() as string;
      if (knownNodeIds.has(last)) {
        result.set(t, last);
        collapsedToNode.add(t);
      }
    }
  }

  // Pass 2: bare ↔ FQN aliasing for whatever survives as a true external
  // dep (i.e. didn't collapse to a workspace node in pass 1).
  const byLastSegment = new Map<string, string[]>();
  for (const t of exts) {
    if (collapsedToNode.has(t)) continue;
    const name = t.slice(4);
    const last = name.includes('.') ? (name.split('.').pop() as string) : name;
    let bucket = byLastSegment.get(last);
    if (!bucket) {
      bucket = [];
      byLastSegment.set(last, bucket);
    }
    bucket.push(t);
  }
  for (const [, bucket] of byLastSegment) {
    // Only collapse when at least one bare form exists in the bucket.
    // Buckets that are all-FQN are left alone — different namespaces
    // sharing the same type name should NOT collide.
    const hasBare = bucket.some(t => !t.slice(4).includes('.'));
    if (!hasBare) continue;
    // Canonical = longest form; tie-break lexicographically asc for
    // determinism across runs.
    bucket.sort((a, b) => (b.length - a.length) || a.localeCompare(b));
    const canonical = bucket[0];
    for (const t of bucket) {
      if (t !== canonical) result.set(t, canonical);
    }
  }
  return result;
}

export function scoreGraph(actual: CodeMapGraph, golden: GoldenSample): ScoreResult {
  // ---- Filter actual nodes to the golden's scope ----
  const actualNodesInScope = Object.values(actual.nodes).filter(n =>
    inScope(n.file, golden.scopeFiles),
  );
  const actualNodeIds = new Set(actualNodesInScope.map(n => n.id));
  const expectedNodeIds = new Set(golden.nodes);

  const nodeIntersection = [...actualNodeIds].filter(id => expectedNodeIds.has(id));
  const missingNodes = [...expectedNodeIds].filter(id => !actualNodeIds.has(id));
  const extraNodes = [...actualNodeIds].filter(id => !expectedNodeIds.has(id));

  const nodeP = ratio(nodeIntersection.length, actualNodeIds.size);
  const nodeR = ratio(nodeIntersection.length, expectedNodeIds.size);

  // ---- Score edges, but only consider edges whose `from` is in scope ----
  // and whose `to` is not on the ignore-prefix list (applied double-sided so
  // it never artificially boosts precision OR recall).
  const ignorePrefixes = golden.ignoreEdgeToPrefixes ?? [];
  const isIgnoredEdge = (e: { to: string }): boolean =>
    ignorePrefixes.some(p => e.to.startsWith(p));
  const actualEdgesInScope = actual.edges.filter(
    e => actualNodeIds.has(e.from) && !isIgnoredEdge(e),
  );
  const goldenEdgesInScope = golden.edges.filter(e => !isIgnoredEdge(e));

  // Canonicalise `ext:` targets so (a) bare ↔ FQN spellings of the same
  // external symbol and (b) `ext:Foo` ↔ workspace node `Foo` collapse to
  // one key. See `buildExtCanonicalMap`.
  const allTargets: string[] = [
    ...actualEdgesInScope.map(e => e.to),
    ...goldenEdgesInScope.map(e => e.to),
  ];
  const allNodeIds = new Set<string>([...actualNodeIds, ...expectedNodeIds]);
  const canonical = buildExtCanonicalMap(allTargets, allNodeIds);
  const canonTo = (to: string): string => canonical.get(to) ?? to;
  const edgeKey = (e: { from: string; to: string }): string => `${e.from}|${canonTo(e.to)}`;

  const actualEdgeKeys = new Set(actualEdgesInScope.map(edgeKey));
  const expectedEdgeKeys = new Set(goldenEdgesInScope.map(edgeKey));

  const edgeIntersection = [...actualEdgeKeys].filter(k => expectedEdgeKeys.has(k));
  const missingEdgeKeys = [...expectedEdgeKeys].filter(k => !actualEdgeKeys.has(k));
  const extraEdgeKeys = [...actualEdgeKeys].filter(k => !expectedEdgeKeys.has(k));

  const parseKey = (k: string): { from: string; to: string } => {
    const [from, to] = k.split('|');
    return { from: from ?? '', to: to ?? '' };
  };

  const edgeP = ratio(edgeIntersection.length, actualEdgeKeys.size);
  const edgeR = ratio(edgeIntersection.length, expectedEdgeKeys.size);

  return {
    nodes: { precision: nodeP, recall: nodeR, f1: f1(nodeP, nodeR) },
    edges: { precision: edgeP, recall: edgeR, f1: f1(edgeP, edgeR) },
    diff: {
      missingNodes,
      extraNodes,
      missingEdges: missingEdgeKeys.map(parseKey),
      extraEdges: extraEdgeKeys.map(parseKey),
    },
  };
}
