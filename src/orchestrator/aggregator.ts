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

  // ---- 1. Merge nodes with namespace-based disambiguation on collisions. ----
  //
  // Why this is non-trivial: lumen has 6+ `AssemblyMarker` classes (one per
  // module), each in its own namespace. The previous "first occurrence wins"
  // strategy silently dropped 5 of them. We now qualify each colliding id
  // with a namespace derived from the parent folder of the file
  // (apps/api/src/Lumen.Modules.Memory/AssemblyMarker.cs ->
  // "Lumen.Modules.Memory.AssemblyMarker"). For lumen-style C# repos the
  // folder mirrors the namespace; for TS/Python it falls back to whatever
  // the parent directory is named.
  //
  // We keep the original short id when there is no collision so the common
  // case (and existing golden samples / tests) stays unchanged.
  const nodesByShort = new Map<string, { file: string; node: CodeNode }[]>();
  for (const a of analyses) {
    for (const n of a.nodes) {
      let group = nodesByShort.get(n.id);
      if (!group) {
        group = [];
        nodesByShort.set(n.id, group);
      }
      // Same file means same logical node (the analyzer occasionally emits
      // duplicates during streaming). Keep the better-verified copy.
      const sameFile = group.find(g => g.file === n.file);
      if (sameFile) {
        if (
          n.verification === 'verified' &&
          sameFile.node.verification !== 'verified'
        ) {
          sameFile.node = n;
        }
        continue;
      }
      group.push({ file: n.file, node: n });
    }
  }

  const nodesById = new Map<string, CodeNode>();
  // For each source file, map the LLM-emitted short id to the final id this
  // aggregator chose. Used to rewrite edges whose `from` / `to` referenced
  // a name that got disambiguated.
  const remapByFile = new Map<string, Map<string, string>>();
  const recordRemap = (file: string, shortId: string, finalId: string): void => {
    let m = remapByFile.get(file);
    if (!m) {
      m = new Map();
      remapByFile.set(file, m);
    }
    m.set(shortId, finalId);
  };

  for (const [shortId, group] of nodesByShort) {
    if (group.length === 1) {
      const e = group[0]!;
      nodesById.set(shortId, e.node);
      recordRemap(e.file, shortId, shortId);
      continue;
    }
    // Collision — namespace-qualify each.
    for (const e of group) {
      const qualifier = qualifierFromFile(e.file);
      const finalId = qualifier
        ? `${qualifier}.${shortId}`
        : `${e.file}::${shortId}`;
      const renamed: CodeNode = { ...e.node, id: finalId };
      nodesById.set(finalId, renamed);
      recordRemap(e.file, shortId, finalId);
    }
    // Note: we used to emit an informational warning here listing every
    // collision (e.g. "AssemblyMarker was defined in 7 files"). It cluttered
    // the chat output every run without giving the user anything to act on —
    // the disambiguation already produced unique ids. If a real collision
    // bug ever surfaces, it shows up as a `Module.Foo` id in the graph itself.
  }

  // Index ids of in-graph nodes for fast lookup.
  const nodeIdSet = new Set(nodesById.keys());

  // Resolve a target short id to a final node id, given the calling source
  // file. We prefer the same-file remap first (most natural — "the class I
  // saw via `using` in this file is most likely the one in my namespace"),
  // then a same-qualifier sibling, then a unique global hit, else give up.
  const resolveTarget = (shortId: string, sourceFile: string): string => {
    const sameFile = remapByFile.get(sourceFile)?.get(shortId);
    if (sameFile && nodesById.has(sameFile)) return sameFile;
    const srcQ = qualifierFromFile(sourceFile);
    if (srcQ) {
      const fqn = `${srcQ}.${shortId}`;
      if (nodesById.has(fqn)) return fqn;
    }
    if (nodesById.has(shortId)) return shortId;
    return shortId;
  };

  // ---- 2. Merge edges, resolve cross-file destinations. ----
  const edgesSeen = new Set<string>();
  const edges: CodeEdge[] = [];
  const pushEdge = (e: CodeEdge): void => {
    const key = `${e.from}|${e.to}|${e.kind}`;
    if (edgesSeen.has(key)) return;
    edgesSeen.add(key);
    edges.push(e);
  };

  // Each external edge needs its source file for id-resolution later. We
  // carry it alongside the edge during the local processing pass.
  const externalEdges: { edge: CodeEdge; sourceFile: string }[] = [];

  for (const a of analyses) {
    for (const e of a.edges) {
      if (e.kind === 'external_calls') {
        externalEdges.push({ edge: e, sourceFile: a.file });
        continue;
      }
      const newFrom = remapByFile.get(a.file)?.get(e.from) ?? e.from;
      const newTo = resolveTarget(e.to, a.file);
      if (e.verified) {
        // Calibrator already confirmed this is in-file; pass through.
        pushEdge({ ...e, from: newFrom, to: newTo });
        continue;
      }
      // verified=false: calibrator couldn't see the target in-file. Try
      // workspace symbol lookup. Found and in-graph → upgrade to verified;
      // found in workspace but outside skeleton → ghost (unverified) node;
      // not found at all → ghost (unverified) node. Either way the edge
      // and the target survive as concrete graph elements per v3 §5.4
      // (no bare auto-nodes from cytoscape).
      if (nodeIdSet.has(newTo)) {
        pushEdge({ ...e, from: newFrom, to: newTo, verified: true });
        continue;
      }
      const hits = await symbols.findInWorkspace(newTo, 5);
      const exact = hits.find(h => h.name === newTo);
      if (exact && nodeIdSet.has(exact.name)) {
        pushEdge({ from: newFrom, to: exact.name, kind: 'calls', verified: true });
        continue;
      }
      // Unresolved target — materialize a ghost node so it gets the grey
      // dotted treatment instead of cytoscape auto-creating an unstyled box.
      if (!nodesById.has(newTo)) {
        nodesById.set(newTo, makeGhostNode(newTo, exact?.file));
        nodeIdSet.add(newTo);
      }
      pushEdge({ from: newFrom, to: newTo, kind: 'calls', verified: false });
      const sourceNode = nodesById.get(newFrom);
      if (sourceNode && sourceNode.verification === 'verified') {
        nodesById.set(newFrom, { ...sourceNode, verification: 'partial' });
      }
    }
  }

  // External edges: try to promote any that turn out to be in-workspace
  // class references before treating them as third-party deps.
  //
  // Why this matters: the v3 prompt tells the LLM to put cross-FILE
  // identifiers into `external_calls`, but a cross-file identifier in a
  // monorepo .NET solution is overwhelmingly an in-workspace class (a
  // handler, a request record, a shared filter), not a NuGet package. If
  // we keep them as `ext:*` the graph loses the class-to-class structure
  // entirely — the user sees a sea of "external deps" instead of the
  // actual call graph.
  //
  // Resolution order:
  //   1. If `ext:Foo` already matches an in-graph node id `Foo`, promote
  //      directly (no LSP roundtrip).
  //   2. Otherwise ask the workspace symbol provider. If the exact-name
  //      hit is also in-graph, promote and retarget onto the canonical id.
  //   3. Otherwise leave as an `ext:` edge (true third-party dep).
  //
  // After promotion, scrub the promoted name from the source node's
  // verificationDetails.droppedExternalCalls so the card no longer claims
  // "Dropped external: RecallByQueryHandler" for something now wired as a
  // real call edge.
  const promotedExtBySource = new Map<string, Set<string>>();
  for (const { edge: e, sourceFile } of externalEdges) {
    const newFrom = remapByFile.get(sourceFile)?.get(e.from) ?? e.from;
    if (!nodeIdSet.has(newFrom)) continue;
    const bare = e.to.replace(/^ext:/, '');
    const promote = (canonicalId: string): void => {
      pushEdge({ from: newFrom, to: canonicalId, kind: 'calls', verified: true });
      let set = promotedExtBySource.get(newFrom);
      if (!set) {
        set = new Set();
        promotedExtBySource.set(newFrom, set);
      }
      set.add(bare);
    };
    const resolved = resolveTarget(bare, sourceFile);
    if (nodeIdSet.has(resolved)) {
      promote(resolved);
      continue;
    }
    const hits = await symbols.findInWorkspace(bare, 5);
    const exact = hits.find(h => h.name === bare);
    if (exact && nodeIdSet.has(exact.name)) {
      promote(exact.name);
      continue;
    }
    pushEdge({ ...e, from: newFrom });
  }
  for (const [sourceId, promoted] of promotedExtBySource) {
    const node = nodesById.get(sourceId);
    if (!node?.verificationDetails) continue;
    const filtered = (node.verificationDetails.droppedExternalCalls ?? [])
      .filter(name => !promoted.has(name));
    nodesById.set(sourceId, {
      ...node,
      verificationDetails: {
        ...node.verificationDetails,
        droppedExternalCalls: filtered,
      },
    });
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

/**
 * Derive a namespace-like qualifier from a workspace-relative file path. We
 * take the parent folder name as a heuristic — on lumen-style C# projects
 * the folder is the namespace ("Lumen.Modules.Memory/AssemblyMarker.cs" ->
 * "Lumen.Modules.Memory"). For TS / Python it falls back to whatever the
 * parent directory happens to be called. Returns empty string for files
 * with no parent folder so callers can detect that case.
 */
function qualifierFromFile(file: string): string {
  const parts = file.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length < 2) return '';
  return parts[parts.length - 2] ?? '';
}


