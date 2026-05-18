import type { CodeMapGraph } from '../shared/types';

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
  bc: string;
  file: string;
  layer?: string;
  verification: 'verified' | 'partial' | 'unverified';
  readingPriority: number;
  confidence: number;
  readState: 'unread' | 'read';
  intent: string;
  methods: {
    name: string;
    sig: string;
    line: number;
    risks: string[];
    read: boolean;
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

export interface MockupChatTurn {
  role: 'user' | 'assistant';
  name: string;
  time: string;
  content: string;
  actions?: { check: boolean; num: string; text: string }[];
}

export interface MockupStats {
  verifiedCount: number;
  partialCount: number;
  unverifiedCount: number;
  filesAnalyzed?: number;
  filesFailed?: number;
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
  stats?: MockupStats;
}

/** Pure transformation; safe to call in both extension and webview contexts. */
export function adaptGraphForMockup(
  graph: CodeMapGraph,
  chatTurns: MockupChatTurn[] = [],
  stats?: MockupStats,
): MockupData {
  const classes: MockupClass[] = Object.values(graph.nodes).map(n => ({
    id: n.id,
    bc: n.boundedContext,
    file: n.file,
    layer: n.layer,
    verification: n.verification,
    readingPriority: n.readingPriority ?? 99,
    confidence: n.confidence,
    readState: n.readState === 'read' ? 'read' : 'unread',
    intent: n.intent,
    methods: n.methods.map(m => ({
      name: m.name,
      sig: m.signature,
      line: m.line,
      risks: m.risks ?? [],
      read: m.readState === 'read',
    })),
    risks: n.risks ?? [],
    verificationDetails: n.verificationDetails,
  }));

  const edges: MockupEdge[] = graph.edges.map(e => ({
    from: e.from,
    to: e.to,
    kind: e.kind,
    verified: e.verified,
  }));

  const externalDeps: MockupExternalDep[] = graph.externalDeps.map(d => ({
    name: d.name,
    kind: d.kind,
  }));

  // Default stats derived from the graph itself so the UI never displays
  // canned numbers from the mockup template. Real eval scores / timings come
  // in via the explicit `stats` argument.
  const derivedStats: MockupStats = stats ?? {
    verifiedCount: classes.filter(c => c.verification === 'verified').length,
    partialCount: classes.filter(c => c.verification === 'partial').length,
    unverifiedCount: classes.filter(c => c.verification === 'unverified').length,
  };

  return { classes, externalDeps, edges, chatTurns, stats: derivedStats };
}
