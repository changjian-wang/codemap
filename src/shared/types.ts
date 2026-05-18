// Shared contracts between the extension host and the WebView UI.
// Any change here must be made in lockstep on both sides; the bundler
// inlines this file into both bundles.

export type NodeKind = 'class';
export type VerificationState = 'verified' | 'partial' | 'unverified';
export type EdgeKind = 'calls' | 'external_calls';

export type RiskType =
  | 'security'
  | 'external_io'
  | 'concurrency'
  | 'low_confidence'
  | 'high_coupling'
  | 'missing_test';

export interface MethodInfo {
  name: string;
  signature: string;
  line: number;
  risks: RiskType[];
  intent?: string;
  calls?: string[];
  externalCalls?: string[];
  readState?: 'unread' | 'read';
}

export interface CodeNode {
  id: string;
  kind: NodeKind;
  file: string;
  range: { startLine: number; endLine: number };
  boundedContext: string;
  intent: string;
  layer?: 'entry' | 'controller' | 'service' | 'repo' | 'util';
  confidence: number;
  risks: { type: RiskType; desc: string }[];
  methods: MethodInfo[];
  readingPriority?: number;
  readState: 'unread' | 'reading' | 'read';

  verification: VerificationState;
  verificationDetails?: {
    rangeAdjusted: boolean;
    droppedCalls: string[];
    droppedExternalCalls: string[];
    reason?: string;
  };
}

export interface CodeEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  verified: boolean;
}

export interface ExternalDep {
  name: string;
  kind: 'package' | 'bcl';
}

export interface EvalScore {
  precision: number;
  recall: number;
  f1: number;
}

export interface CodeMapGraph {
  rootRequest: string;
  scope: string;
  nodes: Record<string, CodeNode>;
  edges: CodeEdge[];
  externalDeps: ExternalDep[];
  rootIntent?: string;
  narrative?: string;
  suggestedEntryNodes?: string[];
  readingOrder?: string[];
  eval?: {
    nodes: EvalScore;
    edges: EvalScore;
  };
}

// ---------- Messages: extension → webview ----------

export type ServerEvent =
  | { type: 'graph_replaced'; graph: CodeMapGraph }
  | { type: 'node_added'; node: CodeNode }
  | { type: 'edge_added'; edge: CodeEdge }
  | { type: 'node_updated'; id: string; patch: Partial<CodeNode> }
  | { type: 'summary'; rootIntent: string; narrative: string; entries: string[] }
  | { type: 'reading_order'; order: string[] }
  | { type: 'progress'; step: string; done: boolean }
  | { type: 'partial_failure'; reason: string; nodeId?: string }
  | {
      type: 'done';
      stats: { nodeCount: number; edgeCount: number; verifiedCount: number; partialCount: number; unverifiedCount: number };
    }
  | { type: 'error'; message: string };

// ---------- Messages: webview → extension ----------

export type ClientEvent =
  | { type: 'ready' }
  | { type: 'mark_read'; nodeId: string; read: boolean }
  | { type: 'mark_method_read'; nodeId: string; method: string; read: boolean }
  | { type: 'jump_to_source'; nodeId: string; method?: string }
  | { type: 'reset_progress' }
  | { type: 'request_focus'; nodeId: string }
  | { type: 'open_chat'; prefill?: string };
