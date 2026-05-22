import type { CodeMapGraph, NodeKind } from '../shared/types';

/**
 * View-layer DTOs consumed by the v3 mockup HTML.
 *
 * The mockup's inline script uses a flat shape ({@link MockupClass} et al.)
 * that pre-dates our shared {@link CodeMapGraph} type. Rather than rewrite the
 * mockup into React in W1, we adapt the graph to this shape and inject it as
 * `window.__CODEMAP_DATA__` before the mockup script runs.
 *
 * W2 replaces the mockup with a real React port consuming {@link CodeMapGraph}
 * directly, at which point this adapter goes away.
 */

export interface MockupClass {
  id: string;
  /** Node kind: class / interface / record / enum. Drives the node shape on the graph and the kind tag. */
  kind: NodeKind;
  bc: string;
  file: string;
  layer?: string;
  verification: 'verified' | 'partial' | 'unverified';
  readingPriority: number;
  confidence: number;
  readState: 'unread' | 'read';
  intent: string;
  /** Project entry-point flag. Webview pins these to dagre's leftmost rank. */
  isEntry?: boolean;
  /**
   * True when this class is reached by ≥30% of the entry methods in
   * {@link MockupData.entries}. Used by focus-mode to render the class
   * in a muted "shared row" at the bottom of the canvas. Entry classes
   * are never marked shared regardless of reachability.
   */
  isShared?: boolean;
  /** Verbatim source-doc comment for the class itself. */
  docComment?: string;
  methods: {
    name: string;
    sig: string;
    line: number;
    risks: string[];
    read: boolean;
    intent?: string;
    calls?: string[];
    externalCalls?: string[];
    /** Verbatim source-doc comment for the method. */
    docComment?: string;
  }[];
  risks: { type: string; desc: string }[];
  verificationDetails?: {
    rangeAdjusted: boolean;
    droppedCalls: string[];
    droppedExternalCalls: string[];
    reason?: string;
  };
}

export interface MockupExternalDep {
  name: string;
  kind: string;
}

export interface MockupEdge {
  from: string;
  to: string;
  kind: 'calls' | 'external_calls';
  verified: boolean;
}

/**
 * A single navigable entry-point method, used by focus-mode to drive
 * subgraph selection. One {@link MockupEntryMethod} is emitted per
 * method on every class with {@link MockupClass.isEntry} = true.
 */
export interface MockupEntryMethod {
  /** Owning class id (matches a {@link MockupClass.id}). */
  classId: string;
  /** Method name (matches a {@link MockupClass.methods}[].name on the owning class). */
  methodName: string;
  /** Method signature, copied verbatim from the owning class. */
  signature: string;
  /** LLM-emitted intent for the method; `''` when the analyzer did not produce one. */
  intent: string;
  /** Risks copied from the owning class's method record. */
  risks: string[];
  /**
   * Class ids reachable from the owning class via class-to-class `calls`
   * edges (cycle-safe BFS). Does NOT include the owning class itself;
   * focus-mode renders the subgraph as `reachableClassIds ∪ {classId}`.
   * `external_calls` edges and `ext:*` targets are never traversed.
   */
  reachableClassIds: string[];
}

export interface MockupChatTurn {
  role: 'user' | 'assistant';
  name: string;
  time: string;
  content: string;
  actions?: { check: boolean; num: string; text: string }[];
}

export interface MockupMeta {
  /** e.g. "Claude 3.5 Sonnet (copilot)" or "gpt-4o". */
  modelLabel?: string;
  /** Workspace folder name. */
  repoName?: string;
  /** Sub-scope (e.g. "apps/api/src/Capture"). Empty for full workspace. */
  scope?: string;
  /** "N files · M LOC" style summary. */
  fileCountText?: string;
  /** Big colored pill (e.g. "📦 WORKSPACE" or "📦 SCOPED"). */
  scopePill?: string;
  /**
   * Human-readable label for each of the mockup's 4 fixed bc slots. The data
   * layer remaps the real `boundedContext` strings onto `host/capture/recall/
   * shared` (the mockup's hardcoded chip data-attrs); this map lets the UI
   * display the real bucket name on each chip and outline section.
   */
  bcLabels?: { host: string; capture: string; recall: string; shared: string };
  /**
   * Class id the webview should select on first render. Used by `/focus`
   * so the right details card opens automatically instead of whichever
   * node happens to win the reading-order sort. Falls back to the first
   * class in reading order when omitted or unknown.
   */
  selectedNodeId?: string;
}

export interface MockupStats {
  verifiedCount: number;
  partialCount: number;
  unverifiedCount: number;
  filesAnalyzed?: number;
  filesFailed?: number;
  /** Files served by the analyzer cache (no LM call). */
  filesFromCache?: number;
  durationMs?: number;
  eval?: {
    nodes: { precision: number; recall: number; f1: number };
    edges: { precision: number; recall: number; f1: number };
  };
}

export interface MockupData {
  classes: MockupClass[];
  externalDeps: MockupExternalDep[];
  edges: MockupEdge[];
  chatTurns: MockupChatTurn[];
  /**
   * Per-entry-method navigation surface consumed by focus-mode. Empty when
   * the graph has no `isEntry: true` classes (e.g. legacy graphs or
   * minimal fixtures).
   */
  entries: MockupEntryMethod[];
  stats?: MockupStats;
  meta?: MockupMeta;
}

/** Pure transformation; safe to call in both extension and webview contexts. */
export function adaptGraphForMockup(
  graph: CodeMapGraph,
  chatTurns: MockupChatTurn[] = [],
  stats?: MockupStats,
  meta?: MockupMeta,
): MockupData {
  // ---- bc remap ----
  // The mockup's chip filter + outline use the hardcoded slots
  // `host/capture/recall/shared`. Real classifier output is usually arbitrary
  // (e.g. `microsoftagentsaiazureaicontentunderstanding`). We assign the top
  // 3 most populous real buckets to host/capture/recall slots, collapse
  // everything else into the shared slot, and emit a label map so the UI can
  // show the real bucket name on each chip.
  //
  // Identity short-circuit: if every real bc is already one of the 4 mockup
  // slots (the demo fixture and our golden tests), skip the remap so the
  // chip labels stay as their canonical "Host" / "Capture" / etc. names.
  const SLOTS = ['host', 'capture', 'recall', 'shared'] as const;
  type Slot = (typeof SLOTS)[number];
  const counts = new Map<string, number>();
  for (const n of Object.values(graph.nodes)) {
    counts.set(n.boundedContext, (counts.get(n.boundedContext) ?? 0) + 1);
  }
  const realBcs = [...counts.keys()];
  const allAreSlots = realBcs.every(bc => (SLOTS as readonly string[]).includes(bc));

  const slotForBc = new Map<string, Slot>();
  const labelForSlot: Record<Slot, string> = {
    host: 'Host',
    capture: 'Capture',
    recall: 'Recall',
    shared: 'Shared',
  };

  if (allAreSlots) {
    for (const bc of realBcs) slotForBc.set(bc, bc as Slot);
  } else {
    const sorted = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([bc]) => bc);
    for (let i = 0; i < sorted.length; i++) {
      slotForBc.set(sorted[i]!, i < 3 ? SLOTS[i]! : 'shared');
    }
    if (sorted[0]) labelForSlot.host = prettifyBc(sorted[0]);
    if (sorted[1]) labelForSlot.capture = prettifyBc(sorted[1]);
    if (sorted[2]) labelForSlot.recall = prettifyBc(sorted[2]);
    if (sorted.length > 4) {
      labelForSlot.shared = 'Other';
    } else if (sorted.length === 4 && sorted[3]) {
      labelForSlot.shared = prettifyBc(sorted[3]);
    } else if (sorted.length <= 3) {
      labelForSlot.shared = 'Shared';
    }
  }

  const classes: MockupClass[] = Object.values(graph.nodes).map(n => ({
    id: n.id,
    kind: n.kind,
    bc: slotForBc.get(n.boundedContext) ?? 'shared',
    file: n.file,
    layer: n.layer,
    verification: n.verification,
    readingPriority: n.readingPriority ?? 99,
    confidence: n.confidence,
    readState: n.readState === 'read' ? 'read' : 'unread',
    intent: n.intent,
    isEntry: n.isEntry,
    docComment: n.docComment,
    methods: n.methods.map(m => ({
      name: m.name,
      sig: m.signature,
      line: m.line,
      risks: m.risks ?? [],
      read: m.readState === 'read',
      intent: m.intent,
      calls: m.calls,
      externalCalls: m.externalCalls,
      docComment: m.docComment,
    })),
    risks: n.risks ?? [],
    verificationDetails: n.verificationDetails,
  }));

  const externalDeps: MockupExternalDep[] = graph.externalDeps.map(d => ({
    name: d.name,
    kind: d.kind,
  }));

  // Defensive: drop edges whose endpoint isn't materialised as a node or
  // an external dep. Cytoscape throws "Can not create edge with nonexistent
  // target" on the first dangling edge and aborts the entire render, so a
  // single stray edge can blank the whole webview. The aggregator now
  // guards against this at source, but this is the boundary between
  // structured graph and webview script — if the boundary holds, no
  // future aggregator regression can blank the panel.
  const validNodeIds = new Set(classes.map(c => c.id));
  const validExtIds = new Set(externalDeps.map(d => `ext:${d.name}`));
  const isResolvable = (id: string): boolean =>
    validNodeIds.has(id) || validExtIds.has(id);
  const edges: MockupEdge[] = [];
  for (const e of graph.edges) {
    if (!isResolvable(e.from) || !isResolvable(e.to)) continue;
    edges.push({ from: e.from, to: e.to, kind: e.kind, verified: e.verified });
  }

  // Default stats derived from the graph itself so the UI never displays
  // canned numbers from the mockup template. Real eval scores / timings come
  // in via the explicit `stats` argument.
  const derivedStats: MockupStats = stats ?? {
    verifiedCount: classes.filter(c => c.verification === 'verified').length,
    partialCount: classes.filter(c => c.verification === 'partial').length,
    unverifiedCount: classes.filter(c => c.verification === 'unverified').length,
  };

  const { entries, sharedClassIds } = computeFocusModeMetadata(classes, edges);
  for (const c of classes) {
    if (sharedClassIds.has(c.id)) c.isShared = true;
  }

  return {
    classes,
    externalDeps,
    edges,
    chatTurns,
    entries,
    stats: derivedStats,
    meta: { ...(meta ?? {}), bcLabels: labelForSlot },
  };
}

/**
 * Turn a classifier bucket like `microsoftagentsaiazureaicontentunderstanding`
 * into something a human can read on a chip. Heuristic only — keeps it short
 * and recognizably tied to the real bucket name.
 */
function prettifyBc(raw: string): string {
  if (!raw) return 'Shared';
  const trimmed = raw.replace(/_/g, '.');
  // Take last two segments if dotted (e.g. `microsoft.agents.ai.azureai` →
  // `azureai`). Capitalize first letter.
  const parts = trimmed.split('.').filter(Boolean);
  const tail = parts[parts.length - 1] ?? trimmed;
  // Cap at 18 chars so the chip stays one line.
  const capped = tail.length > 18 ? tail.slice(0, 17) + '…' : tail;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/**
 * Build the focus-mode navigation surface: one {@link MockupEntryMethod}
 * per method on every `isEntry: true` class, plus the set of class ids
 * that qualify as "shared" (reached by ≥30% of the entry methods).
 *
 * Exposed for unit testing. Pure function, called once at the tail end
 * of {@link adaptGraphForMockup}.
 */
export function computeFocusModeMetadata(
  classes: MockupClass[],
  edges: MockupEdge[],
): { entries: MockupEntryMethod[]; sharedClassIds: Set<string> } {
  const classIds = new Set(classes.map(c => c.id));

  // Adjacency on class-to-class `calls` edges only. External edges
  // (`external_calls` / `ext:*` targets) are never traversed — focus-mode
  // operates on classes, not on the externals row.
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== 'calls') continue;
    if (!classIds.has(e.from) || !classIds.has(e.to)) continue;
    const list = adjacency.get(e.from);
    if (list) list.push(e.to);
    else adjacency.set(e.from, [e.to]);
  }

  const entries: MockupEntryMethod[] = [];
  const reachableCache = new Map<string, string[]>();
  for (const c of classes) {
    if (!c.isEntry) continue;
    let reachable = reachableCache.get(c.id);
    if (!reachable) {
      reachable = bfsReachable(c.id, adjacency);
      reachableCache.set(c.id, reachable);
    }
    for (const m of c.methods) {
      entries.push({
        classId: c.id,
        methodName: m.name,
        signature: m.sig,
        intent: m.intent ?? '',
        risks: m.risks,
        reachableClassIds: reachable,
      });
    }
  }

  const sharedClassIds = new Set<string>();
  if (entries.length > 0) {
    const entryClassIds = new Set(entries.map(e => e.classId));
    const reachCount = new Map<string, number>();
    for (const entry of entries) {
      for (const id of entry.reachableClassIds) {
        reachCount.set(id, (reachCount.get(id) ?? 0) + 1);
      }
    }
    // Integer comparison avoids float-equality surprises at the 30% boundary.
    // `count / entries.length >= 0.30`  ⇔  `count * 100 >= entries.length * 30`.
    const denomTimes30 = entries.length * 30;
    for (const [id, count] of reachCount.entries()) {
      if (entryClassIds.has(id)) continue;
      if (count * 100 >= denomTimes30) sharedClassIds.add(id);
    }
  }

  return { entries, sharedClassIds };
}

function bfsReachable(
  start: string,
  adjacency: Map<string, string[]>,
): string[] {
  const reachable: string[] = [];
  const visited = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const neighbors = adjacency.get(cur);
    if (!neighbors) continue;
    for (const n of neighbors) {
      if (visited.has(n)) continue;
      visited.add(n);
      reachable.push(n);
      queue.push(n);
    }
  }
  return reachable;
}
