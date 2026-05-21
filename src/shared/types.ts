// Shared contracts between the extension host and the WebView UI.
// Any change here must be made in lockstep on both sides; the bundler
// inlines this file into both bundles.

export type NodeKind = 'class' | 'interface' | 'record' | 'enum';
export type VerificationState = 'verified' | 'partial' | 'unverified';
export type EdgeKind = 'calls' | 'external_calls';

/**
 * What kind of project entry-point a class is, when {@link CodeNode.isEntry}
 * is true. Drives the Entries panel grouping and the per-card badge.
 *
 * Tagged by the LLM during analyze; consumed by the WebView only — the
 * graph / calibrator / aggregator do not branch on this.
 *
 *  - `http_endpoint` — maps HTTP routes (ASP.NET MapXxx / MVC controller,
 *    Express router, FastAPI router class, Flask Blueprint, gRPC service).
 *  - `cli_main` — top-level Program / Main, CLI framework root command.
 *  - `worker` — BackgroundService / IHostedService / cron job class.
 *  - `sample` — self-contained example program under `samples/` /
 *    `examples/`, used as a faux entry-point when a library has no real
 *    HTTP / CLI surface.
 *  - `public_api` — library / SDK surface class whose public extension
 *    methods are the user-facing entry surface (e.g. `AddDawningCaching`).
 */
export type EntryKind =
  | 'http_endpoint'
  | 'cli_main'
  | 'worker'
  | 'sample'
  | 'public_api';

/**
 * Kind-specific entry-point metadata. All fields optional — populate only
 * what is statically extractable from the source. Display layer treats an
 * absent field as "no info to show", not as an error.
 */
export interface EntryMeta {
  /** http_endpoint: `["GET /recall", "POST /capture/batch", ...]`. */
  routes?: string[];
  /** cli_main: subcommand names, e.g. `["recall", "capture"]`. */
  commands?: string[];
  /** sample: file stem, e.g. `"BasicCaching"`. */
  sampleName?: string;
  /** public_api: extension / static method names, e.g. `["AddDawningCaching"]`. */
  publicApis?: string[];
}

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
  /**
   * Verbatim leading documentation comment (Python docstring, C# `///`,
   * JSDoc / TSDoc) extracted from source. Empty/unset when the symbol has
   * no doc comment.
   */
  docComment?: string;
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

  /**
   * True when the LLM tagged this class as a user-facing entry-point —
   * something the reader would pick as the start of a call chain rather
   * than discover by following an edge. Drives the Entries panel; the
   * graph and calibrator do not branch on it.
   *
   * Distinct from `layer === 'entry'`, which is a coarser architectural
   * role used by reading-order sort. A class can be `layer: 'controller'`
   * AND `isEntry: true` (HTTP endpoint class), or `layer: 'util'` AND
   * `isEntry: true` (sample program), or `layer: 'entry'` AND
   * `isEntry: false` (composition root with no user-callable surface).
   */
  isEntry?: boolean;
  entryKind?: EntryKind;
  entryMeta?: EntryMeta;

  /**
   * Verbatim leading documentation comment (Python docstring, C# `///`,
   * JSDoc / TSDoc) extracted from source. Empty/unset when the class has
   * no doc comment.
   */
  docComment?: string;

  verification: VerificationState;
  verificationDetails?: {
    rangeAdjusted: boolean;
    droppedCalls: string[];
    droppedExternalCalls: string[];
    reason?: string;
    /**
     * True when the language server did not respond for this file at
     * calibration time. The node is presented as `verified` by default
     * (no signal ≠ negative signal), but the UI / chat surface this so
     * the user knows the verification scores are unreliable.
     */
    lspNotReady?: boolean;
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
  | { type: 'open_chat'; prefill?: string }
  | { type: 'pick_scope'; currentScope?: string; rootName?: string }
  | { type: 'export_graph'; format?: 'yaml' | 'html' };
