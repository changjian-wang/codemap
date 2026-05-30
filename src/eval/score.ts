// Phase 3.4 -- v2 scorer.
//
// Scores a v2 CodeMapGraph against a hand-authored GoldenSample using the
// same strict-overlap formula the v0.0.x scorer used, so legacy class-level
// goldens (lumen-v0.0.6/7/8 YAML) continue to regress against the new
// orchestrator output without a rewrite.
//
// Two-tier model:
//   1. Class-level (mandatory): golden.classNodes + golden.classEdges
//      compared against graph.classes + graph.classEdges (derived view).
//      Drop-in compatible with legacy GoldenSample which used `nodes` and
//      `edges` -- both spellings are accepted.
//   2. Method-level (opt-in): golden.methodNodes + golden.methodEdges
//      compared against graph.methods + graph.methodEdges. Skipped silently
//      when the golden does not declare them.
//
// Scoping:
//   `scopeFiles` is a list of workspace-relative path prefixes. Class
//   nodes are filtered by `class.file`; method nodes inherit the class
//   filter via `ownerClassId`. An edge is in scope iff its source endpoint
//   is in scope (target endpoint is allowed to leave the scope -- it
//   represents an outbound dependency).
//
// External-target canonicalisation: ported from legacy `score.ts` so
// `ext:Foo` <-> bare `Foo` (workspace node) and `ext:Foo` <-> `ext:Ns.Foo`
// (bare<->FQN aliasing) collapse to one key before set intersection.

import type {
  CodeMapGraph,
  ClassEdgeDerived,
  MethodEdge,
} from '../shared/types';

// =========================================================================
//   Golden shape (back-compat with legacy)
// =========================================================================

export interface GoldenEdge {
  from: string;
  to: string;
  kind?: 'calls' | 'external_calls';
}

export interface GoldenMethodEdge {
  from: string;
  to: string;
  kind?: 'calls' | 'external_calls';
}

export interface GoldenSample {
  name: string;
  description?: string;
  scopeFiles?: string[];

  classNodes?: string[];
  classEdges?: GoldenEdge[];

  /** Legacy field name for classNodes. */
  nodes?: string[];
  /** Legacy field name for classEdges. */
  edges?: GoldenEdge[];

  methodNodes?: string[];
  methodEdges?: GoldenMethodEdge[];

  ignoreEdgeToPrefixes?: string[];
}

// =========================================================================
//   Score result
// =========================================================================

export interface EvalScore {
  precision: number;
  recall: number;
  f1: number;
}

export interface TierDiff<TEdge> {
  missingNodes: string[];
  extraNodes: string[];
  missingEdges: TEdge[];
  extraEdges: TEdge[];
}

export interface ScoreResult {
  classes: EvalScore;
  classEdges: EvalScore;
  /** Populated only when the golden declares methodNodes. */
  methods?: EvalScore;
  /** Populated only when the golden declares methodEdges. */
  methodEdges?: EvalScore;
  diff: {
    classes: TierDiff<{ from: string; to: string }>;
    methods?: TierDiff<{ from: string; to: string }>;
  };
}

// =========================================================================
//   Math
// =========================================================================

function ratio(num: number, denom: number): number {
  return denom === 0 ? 0 : num / denom;
}

function f1(p: number, r: number): number {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

function inScope(file: string, scopeFiles: string[] | undefined): boolean {
  if (!scopeFiles || scopeFiles.length === 0) return true;
  return scopeFiles.some((s) => file.startsWith(s));
}

// =========================================================================
//   External-target canonicalisation (ported from legacy)
// =========================================================================

function buildExtCanonicalMap(
  targets: Iterable<string>,
  knownNodeIds: Set<string>,
): Map<string, string> {
  const exts = new Set<string>();
  for (const t of targets) {
    if (t.startsWith('ext:')) exts.add(t);
  }
  const result = new Map<string, string>();

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
    const hasBare = bucket.some((t) => !t.slice(4).includes('.'));
    if (!hasBare) continue;
    bucket.sort((a, b) => b.length - a.length || a.localeCompare(b));
    const canonical = bucket[0];
    for (const t of bucket) {
      if (t !== canonical) result.set(t, canonical);
    }
  }
  return result;
}

// =========================================================================
//   Tier scorer
// =========================================================================

interface TierInputs<TEdge> {
  actualNodeIds: Set<string>;
  expectedNodeIds: Set<string>;
  actualEdges: TEdge[];
  expectedEdges: TEdge[];
  edgeFrom(e: TEdge): string;
  edgeTo(e: TEdge): string;
  ignoreEdgeToPrefixes: string[];
}

interface TierOutputs {
  nodes: EvalScore;
  edges: EvalScore;
  diff: TierDiff<{ from: string; to: string }>;
}

function scoreTier<TEdge>(inputs: TierInputs<TEdge>): TierOutputs {
  const { actualNodeIds, expectedNodeIds, actualEdges, expectedEdges } = inputs;

  const nodeHit = [...actualNodeIds].filter((id) => expectedNodeIds.has(id));
  const missingNodes = [...expectedNodeIds].filter((id) => !actualNodeIds.has(id));
  const extraNodes = [...actualNodeIds].filter((id) => !expectedNodeIds.has(id));
  const nodeP = ratio(nodeHit.length, actualNodeIds.size);
  const nodeR = ratio(nodeHit.length, expectedNodeIds.size);

  const isIgnored = (to: string): boolean =>
    inputs.ignoreEdgeToPrefixes.some((p) => to.startsWith(p));

  const filteredActual = actualEdges.filter(
    (e) => actualNodeIds.has(inputs.edgeFrom(e)) && !isIgnored(inputs.edgeTo(e)),
  );
  const filteredExpected = expectedEdges.filter((e) => !isIgnored(inputs.edgeTo(e)));

  const allTargets = [
    ...filteredActual.map((e) => inputs.edgeTo(e)),
    ...filteredExpected.map((e) => inputs.edgeTo(e)),
  ];
  const knownNodes = new Set<string>([...actualNodeIds, ...expectedNodeIds]);
  const canonical = buildExtCanonicalMap(allTargets, knownNodes);
  const canonTo = (to: string): string => canonical.get(to) ?? to;
  const key = (from: string, to: string): string => `${from}|${canonTo(to)}`;
  const edgeKey = (e: TEdge): string => key(inputs.edgeFrom(e), inputs.edgeTo(e));

  const actualKeys = new Set(filteredActual.map(edgeKey));
  const expectedKeys = new Set(filteredExpected.map(edgeKey));

  const edgeHit = [...actualKeys].filter((k) => expectedKeys.has(k));
  const missingKeys = [...expectedKeys].filter((k) => !actualKeys.has(k));
  const extraKeys = [...actualKeys].filter((k) => !expectedKeys.has(k));
  const edgeP = ratio(edgeHit.length, actualKeys.size);
  const edgeR = ratio(edgeHit.length, expectedKeys.size);

  const parseKey = (k: string): { from: string; to: string } => {
    const [from, to] = k.split('|');
    return { from: from ?? '', to: to ?? '' };
  };

  return {
    nodes: { precision: nodeP, recall: nodeR, f1: f1(nodeP, nodeR) },
    edges: { precision: edgeP, recall: edgeR, f1: f1(edgeP, edgeR) },
    diff: {
      missingNodes,
      extraNodes,
      missingEdges: missingKeys.map(parseKey),
      extraEdges: extraKeys.map(parseKey),
    },
  };
}

// =========================================================================
//   Public entry
// =========================================================================

export function scoreGraph(graph: CodeMapGraph, golden: GoldenSample): ScoreResult {
  const expectedClassIds = new Set(golden.classNodes ?? golden.nodes ?? []);
  const expectedClassEdges: GoldenEdge[] = golden.classEdges ?? golden.edges ?? [];
  const ignorePrefixes = golden.ignoreEdgeToPrefixes ?? [];

  const actualClassNodesInScope = Object.values(graph.classes).filter((c) =>
    inScope(c.file, golden.scopeFiles),
  );
  const actualClassIds = new Set(actualClassNodesInScope.map((c) => c.id));

  const classTier = scoreTier<ClassEdgeDerived | GoldenEdge>({
    actualNodeIds: actualClassIds,
    expectedNodeIds: expectedClassIds,
    actualEdges: graph.classEdges as (ClassEdgeDerived | GoldenEdge)[],
    expectedEdges: expectedClassEdges as (ClassEdgeDerived | GoldenEdge)[],
    edgeFrom: (e) => ('source' in e ? e.source : (e as GoldenEdge).from),
    edgeTo: (e) => ('target' in e ? e.target : (e as GoldenEdge).to),
    ignoreEdgeToPrefixes: ignorePrefixes,
  });

  const result: ScoreResult = {
    classes: classTier.nodes,
    classEdges: classTier.edges,
    diff: { classes: classTier.diff },
  };

  if (golden.methodNodes || golden.methodEdges) {
    const expectedMethodIds = new Set(golden.methodNodes ?? []);
    const expectedMethodEdges = golden.methodEdges ?? [];

    const actualMethodIds = new Set(
      Object.values(graph.methods)
        .filter((m) => actualClassIds.has(m.ownerClassId))
        .map((m) => m.id),
    );

    const methodTier = scoreTier<MethodEdge | GoldenMethodEdge>({
      actualNodeIds: actualMethodIds,
      expectedNodeIds: expectedMethodIds,
      actualEdges: graph.methodEdges as (MethodEdge | GoldenMethodEdge)[],
      expectedEdges: expectedMethodEdges as (MethodEdge | GoldenMethodEdge)[],
      edgeFrom: (e) => ('source' in e ? e.source : (e as GoldenMethodEdge).from),
      edgeTo: (e) => ('target' in e ? e.target : (e as GoldenMethodEdge).to),
      ignoreEdgeToPrefixes: ignorePrefixes,
    });

    result.methods = methodTier.nodes;
    result.methodEdges = methodTier.edges;
    result.diff.methods = methodTier.diff;
  }

  return result;
}
