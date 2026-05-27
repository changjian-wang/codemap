// CodeMap v2 graph shape — DRAFT for slice 0.2.
//
// Two-tier node model:
//   - ClassNode is a swimlane / grouping container.
//   - MethodNode is the first-class graph node (what the renderer draws,
//     what method-level edges connect).
//
// Why this shape:
//   - 0.0.8 mockup synthesized method-as-node at render time from a
//     class-level CodeMapGraph. v2 makes that explicit upstream so the
//     orchestrator owns the data model, not the webview.
//   - Eval baselines (lumen-v0.0.6/7/8 YAML) are class-level. To preserve
//     regression value we expose a DERIVED `classEdges` view aggregated
//     from `methodEdges` — same numbers, computed at the boundary, no
//     duplicate source of truth.
//   - All ids are stable strings. Method id = `${classId}.${methodName}`,
//     ext id = `ext:${name}` — matches mockup conventions so the webview
//     resolver in codemap-view.html (Pass 2/3) ports without remapping.
//
// Conventions (locked 2026-05-27):
//   - Overload collapse: method id = bare `Class.Method`; overloads merge
//     into one MethodNode. Matches v0.0.6/7/8 baseline behaviour.
//   - Constructors: orchestrator does NOT emit MethodNodes for
//     constructors. They surface in the detail panel only (via class
//     range), never as graph nodes or edges.
//   - Class-id fallback in MethodEdge.target: when the calibrator can
//     resolve callee CLASS but not callee METHOD, target stays as the
//     bare class id (no `ext:` prefix). Scorer counts this as a full hit
//     against a golden's class-level edge — golden granularity is the
//     ceiling we score against, so a method→class edge that lands on the
//     correct class is not penalised.

// =========================================================================
//   Enums
// =========================================================================

export type NodeKind = 'class' | 'interface' | 'record' | 'enum' | 'struct';
export type VerificationState = 'verified' | 'partial' | 'unverified';
export type EdgeKind = 'calls' | 'external_calls';
export type Visibility = 'public' | 'private' | 'protected' | 'internal';
export type LayerKind = 'entry' | 'controller' | 'service' | 'repo' | 'util';

export type EntryKind =
  | 'http_endpoint'
  | 'cli_main'
  | 'worker'
  | 'sample'
  | 'public_api';

export type RiskType =
  | 'security'
  | 'external_io'
  | 'concurrency'
  | 'low_confidence'
  | 'high_coupling'
  | 'missing_test';

// =========================================================================
//   Node tier 1: Class (swimlane)
// =========================================================================

export interface ClassNode {
  /** Unique within the graph. Bare class name in v2 (no FQN). */
  id: string;
  kind: NodeKind;
  /** Bounded-context bucket — drives swimlane colour & ordering. */
  boundedContext: string;
  /** Workspace-relative file path. */
  file: string;
  range: { startLine: number; endLine: number };

  intent: string;
  docComment?: string;
  layer?: LayerKind;
  /** LLM confidence on this class's metadata, [0..1]. */
  confidence: number;
  risks: { type: RiskType; desc: string }[];

  /** Entry-point tagging. Drives the Entries panel and reading order. */
  isEntry?: boolean;
  entryKind?: EntryKind;
  entryMeta?: EntryMeta;

  /**
   * Post-aggregation flag: true when reached by ≥30% of entry methods.
   * Drives "shared row" treatment in focus mode (renderer concern).
   */
  isShared?: boolean;

  /** Method ids belonging to this class, in declaration order. */
  methodIds: string[];

  verification: VerificationState;
  verificationDetails?: VerificationDetails;
}

export interface EntryMeta {
  routes?: string[];
  commands?: string[];
  sampleName?: string;
  publicApis?: string[];
}

export interface VerificationDetails {
  rangeAdjusted: boolean;
  droppedTargets: string[];
  reason?: string;
  /** True when LSP didn't respond at calibration time. */
  lspNotReady?: boolean;
}

// =========================================================================
//   Node tier 2: Method (first-class)
// =========================================================================

export interface MethodNode {
  /** `${ownerClassId}.${name}`. Overloads collapse into one node. */
  id: string;
  /** Must exist in CodeMapGraph.classes. */
  ownerClassId: string;
  /** Bare name, no signature, no parens. */
  name: string;
  /** Display signature, e.g. `(Guid id, CancellationToken ct)`. */
  signature: string;
  line: number;

  visibility?: Visibility;
  isStatic?: boolean;

  intent?: string;
  docComment?: string;
  risks: RiskType[];

  /** Per-method read state. Class-level read tracking is dropped in v2. */
  readState?: 'unread' | 'read';

  /**
   * Inherits owner class verification by default; the calibrator may
   * downgrade individual methods when all their calls were dropped.
   */
  verification: VerificationState;
}

// =========================================================================
//   Node tier 3: External dependency
// =========================================================================

export interface ExternalDepNode {
  /** `ext:${name}`. */
  id: string;
  /** Bare name without the `ext:` prefix. */
  name: string;
  kind: 'package' | 'bcl';
}

// =========================================================================
//   Edges
// =========================================================================

export interface MethodEdge {
  id: string;
  /** Always a MethodNode id. */
  source: string;
  /**
   * Resolution priority — set by the aggregator at canonicalization:
   *   1. MethodNode id ("Class.Method")
   *   2. ExternalDepNode id ("ext:Foo")
   *   3. ClassNode id ("Class") — fallback when callee method couldn't
   *      be resolved but the class itself is in scope; preserves reach.
   */
  target: string;
  kind: EdgeKind;
  /** True when both endpoints survived LSP calibration. */
  verified: boolean;
}

/**
 * Class-level edge DERIVED from MethodEdges. Recomputed from methodEdges
 * by the aggregator and never edited directly. Exists so the scorer can
 * keep comparing against v0.0.6/7/8 class-level golden samples without
 * forcing a baseline rewrite on day 1.
 */
export interface ClassEdgeDerived {
  source: string;  // ClassNode id
  /** ClassNode id, or `ext:Foo` for external. */
  target: string;
  kind: EdgeKind;
  /** Number of underlying MethodEdges that produced this class edge. */
  multiplicity: number;
  /** True when at least one underlying MethodEdge is verified. */
  verified: boolean;
}

// =========================================================================
//   Graph
// =========================================================================

export interface CodeMapGraph {
  /** Bump on any breaking change to this file. */
  schemaVersion: 2;

  rootRequest: string;
  scope: string;
  /** workspaceFolder URI string. Multi-root safety. */
  workspaceRoot?: string;

  rootIntent?: string;
  narrative?: string;

  /**
   * Bounded contexts present, in display order. Drives swimlane palette
   * and BC filter chips. Empty array = single-bc graph.
   */
  boundedContexts: string[];

  classes: Record<string, ClassNode>;
  methods: Record<string, MethodNode>;
  externalDeps: Record<string, ExternalDepNode>;

  /** The renderer consumes this directly. */
  methodEdges: MethodEdge[];

  /** Derived; empty until the aggregator has run the derivation pass. */
  classEdges: ClassEdgeDerived[];

  /** MethodNode ids the LLM tagged as user-facing entry surfaces. */
  entryMethodIds: string[];

  /**
   * Reading order in v2 is a list of METHOD ids (was class ids in v1).
   * The outline tree groups them under their owner classes.
   */
  readingOrder?: string[];

  eval?: {
    classes: EvalScore;
    methodEdges: EvalScore;
    /** For lumen-v0.0.6/7/8 baseline regression. */
    classEdges: EvalScore;
  };
}

export interface EvalScore {
  precision: number;
  recall: number;
  f1: number;
}
