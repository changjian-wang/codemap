import type { CodeMapGraph, CodeNode, CodeEdge, ExternalDep } from '../shared/types';
import type { SymbolProvider } from '../calibration/symbol-provider';
import type { AnalyzeResult } from './single-file-analyzer';
import { computeReadingOrder } from '../graph/reading-order';

/**
 * Aggregator — merges per-file analyzer outputs into the workspace-level
 * {@link CodeMapGraph}, and resolves cross-file edges via
 * {@link SymbolProvider.findInWorkspace}.
 *
 * Two responsibilities split cleanly:
 *
 *  1. Node merge (sync, pure). One class id = one node, even if multiple
 *     files mention it. The first occurrence wins; later mentions only
 *     contribute edges. A duplicate node id from a different file is treated
 *     as a (rare) conflict and logged in {@link AggregateResult.warnings}.
 *
 *  2. Cross-file edge resolution (async, talks to SymbolProvider). An edge
 *     `Foo -> Bar` where Bar is not in this file becomes a cross-file edge
 *     that we re-target onto the class id found via workspace symbol lookup;
 *     when the lookup fails we keep the edge but mark it unverified so the
 *     UI shows the grey dotted line per v3 §5.4.
 *
 *  3. External_calls (ext:*) are de-duped into the graph-level
 *     externalDeps list. We default `kind: 'package'` — distinguishing
 *     package vs BCL needs a project-manifest reader, deferred to v1.1.
 *
 *  4. Reading order is computed on the final merged graph.
 */

export interface AggregateInput {
  rootRequest: string;
  scope: string;
  analyses: AnalyzeResult[];
  /** Class ids known to exist somewhere in the workspace, for soft lookups. */
  symbols: SymbolProvider;
}

export interface AggregateResult {
  graph: CodeMapGraph;
  warnings: string[];
}

export async function aggregate(input: AggregateInput): Promise<AggregateResult> {
  const { rootRequest, scope, analyses, symbols } = input;
  const warnings: string[] = [];

  // ---- 1. Merge nodes. First occurrence wins; conflict warning otherwise. ----
  const nodesById = new Map<string, CodeNode>();
  for (const a of analyses) {
    for (const n of a.nodes) {
      const existing = nodesById.get(n.id);
      if (!existing) {
        nodesById.set(n.id, n);
        continue;
      }
      if (existing.file !== n.file) {
        warnings.push(
          `duplicate class id "${n.id}" found in both ${existing.file} and ${n.file}; keeping first`,
        );
      }
      // If the duplicate is verified and the first occurrence was not, prefer
      // the verified one — better information.
      if (n.verification === 'verified' && existing.verification !== 'verified') {
        nodesById.set(n.id, n);
      }
    }
  }

  // Index ids of in-graph nodes for fast lookup.
  const nodeIdSet = new Set(nodesById.keys());

  // ---- 2. Merge edges, resolve cross-file destinations. ----
  const edgesSeen = new Set<string>();
  const edges: CodeEdge[] = [];
  const pushEdge = (e: CodeEdge): void => {
    const key = `${e.from}|${e.to}|${e.kind}`;
    if (edgesSeen.has(key)) return;
    edgesSeen.add(key);
    edges.push(e);
  };

  const externalEdges: CodeEdge[] = [];

  for (const a of analyses) {
    for (const e of a.edges) {
      if (e.kind === 'external_calls') {
        externalEdges.push(e);
        continue;
      }
      if (e.verified) {
        // Calibrator already confirmed this is in-file; pass through.
        pushEdge(e);
        continue;
      }
      // verified=false: calibrator couldn't see the target in-file. Try
      // workspace symbol lookup. Found and in-graph → upgrade to verified;
      // found in workspace but outside skeleton → ghost (unverified) node;
      // not found at all → ghost (unverified) node. Either way the edge
      // and the target survive as concrete graph elements per v3 §5.4
      // (no bare auto-nodes from cytoscape).
      if (nodeIdSet.has(e.to)) {
        pushEdge({ ...e, verified: true });
        continue;
      }
      const hits = await symbols.findInWorkspace(e.to, 5);
      const exact = hits.find(h => h.name === e.to);
      if (exact && nodeIdSet.has(exact.name)) {
        pushEdge({ from: e.from, to: exact.name, kind: 'calls', verified: true });
        continue;
      }
      // Unresolved target — materialize a ghost node so it gets the grey
      // dotted treatment instead of cytoscape auto-creating an unstyled box.
      if (!nodesById.has(e.to)) {
        nodesById.set(e.to, makeGhostNode(e.to, exact?.file));
        nodeIdSet.add(e.to);
      }
      pushEdge({ from: e.from, to: e.to, kind: 'calls', verified: false });
      const sourceNode = nodesById.get(e.from);
      if (sourceNode && sourceNode.verification === 'verified') {
        nodesById.set(e.from, { ...sourceNode, verification: 'partial' });
      }
    }
  }

  // External edges go through unchanged. Drop edges whose `from` doesn't exist
  // (orphan after a node-merge failure).
  for (const e of externalEdges) {
    if (!nodeIdSet.has(e.from)) continue;
    pushEdge(e);
  }

  // ---- 3. External dep list (de-duped from ext:* edge targets). ----
  const externalDeps: ExternalDep[] = [];
  const seenExt = new Set<string>();
  for (const e of edges) {
    if (e.kind !== 'external_calls') continue;
    const name = e.to.replace(/^ext:/, '');
    if (seenExt.has(name)) continue;
    seenExt.add(name);
    externalDeps.push({ name, kind: 'package' });
  }

  // ---- 4. Summary fields. Prefer the entry point's narrative. ----
  let rootIntent: string | undefined;
  let narrative: string | undefined;
  const suggestedEntryNodes: string[] = [];
  for (const a of analyses) {
    if (!rootIntent && a.rootIntent) rootIntent = a.rootIntent;
    if (!narrative && a.narrative) narrative = a.narrative;
    if (a.suggestedEntryNodes) suggestedEntryNodes.push(...a.suggestedEntryNodes);
  }
  // De-dupe entries, preserve order.
  const seenEntries = new Set<string>();
  const uniqueEntries = suggestedEntryNodes.filter(id => {
    if (seenEntries.has(id) || !nodeIdSet.has(id)) return false;
    seenEntries.add(id);
    return true;
  });

  const nodes: Record<string, CodeNode> = {};
  for (const [id, n] of nodesById) nodes[id] = n;

  const graphSansOrder: CodeMapGraph = {
    rootRequest,
    scope,
    nodes,
    edges,
    externalDeps,
    rootIntent,
    narrative,
    suggestedEntryNodes: uniqueEntries.length > 0 ? uniqueEntries : undefined,
  };

  const readingOrder = computeReadingOrder(graphSansOrder);
  const graph: CodeMapGraph = { ...graphSansOrder, readingOrder };

  return { graph, warnings };
}

function makeGhostNode(id: string, file: string | undefined): CodeNode {
  return {
    id,
    kind: 'class',
    file: file ?? `(unresolved: ${id})`,
    range: { startLine: 0, endLine: 0 },
    boundedContext: 'shared',
    intent:
      'Referenced by another class but the LLM did not (or could not) analyze it. ' +
      'Could be outside the picked skeleton, a hallucinated identifier, or a class ' +
      'that needs to be added via /focus.',
    confidence: 0,
    risks: [{ type: 'low_confidence', desc: 'unresolved in current skeleton' }],
    methods: [],
    readingPriority: 99,
    readState: 'unread',
    verification: 'unverified',
    verificationDetails: {
      rangeAdjusted: false,
      droppedCalls: [],
      droppedExternalCalls: [],
      reason: file
        ? `Found in workspace at ${file} but outside the analyzed skeleton`
        : 'Not found by executeWorkspaceSymbolProvider',
    },
  };
}

