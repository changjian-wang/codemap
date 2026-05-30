// Phase 3.3a -- per-file analyzer outputs + per-method calibrator callees
// fold down into a single CodeMapGraph.
//
// Pure function. No fs, no LLM, no vscode. The orchestrator drives the
// async work; this module is the deterministic folder at the bottom.
//
// Responsibilities:
//   1. Merge ClassNode / MethodNode from every AnalyzeResult into the
//      graph's class / method Records. First-wins on id collisions
//      (lumen-mini has none; multi-module workspaces with duplicate bare
//      class ids -- rare -- get a warning + the loser is dropped).
//   2. Build MethodEdges from the calibrator's resolveCallees() output.
//      Target resolution priority per v2 types.ts conventions:
//         method id (Class.Method) > class id (bare) > ext:Foo
//      Constructors / localFunction / unknown callees are skipped
//      (v2 convention: constructors never become MethodNodes or edges).
//   3. Collect externalDeps from any edge whose target starts with `ext:`.
//   4. Derive class-level edges from method edges (collapse + multiplicity).
//   5. Upgrade per-method and per-class verification from 'unverified' to
//      'verified' / 'partial' based on whether the calibrator answered
//      and whether every resolved callee landed in-graph.
//   6. Collect entryMethodIds from classes the LLM tagged with isEntry.
//   7. Build a readingOrder: entries first (in entryMethodIds order), then
//      remaining methods grouped by class declaration order.
//   8. Compute boundedContexts in display order (freq desc, "shared" last).

import type { Callee } from '../shared/calibrator-protocol';
import type {
  ClassEdgeDerived,
  ClassNode,
  CodeMapGraph,
  EdgeKind,
  ExternalDepNode,
  MethodEdge,
  MethodNode,
  VerificationDetails,
  VerificationState,
} from '../shared/types';
import type { AnalyzeResult } from './analyze-file';

export interface AggregateInput {
  rootRequest: string;
  scope: string;
  workspaceRoot?: string;
  analyses: readonly AnalyzeResult[];
  /**
   * Per-method callee lists from CalibratorService.resolveCallees.
   * Methods missing from this map are treated as "calibrator could not
   * answer" -- they fall back to the LLM-declared calls from
   * AnalyzeResult.llmCalls and emit verified=false edges. Methods with
   * no calibrator data AND no llmCalls get no outbound edges and stay
   * verification='unverified'.
   */
  callees: ReadonlyMap<string, readonly Callee[]>;
}

export interface AggregateResult {
  graph: CodeMapGraph;
  warnings: string[];
}

export function aggregate(input: AggregateInput): AggregateResult {
  const warnings: string[] = [];

  const classes: Record<string, ClassNode> = {};
  const methods: Record<string, MethodNode> = {};
  let rootIntent: string | undefined;
  let narrative: string | undefined;

  for (const a of input.analyses) {
    if (!rootIntent && a.rootIntent) rootIntent = a.rootIntent;
    if (!narrative && a.narrative) narrative = a.narrative;

    for (const c of a.classes) {
      if (classes[c.id]) {
        warnings.push(
          `duplicate class id '${c.id}' (kept ${classes[c.id]!.file}, dropped ${c.file})`,
        );
        continue;
      }
      classes[c.id] = { ...c };
    }
    for (const m of a.methods) {
      if (methods[m.id]) {
        warnings.push(`duplicate method id '${m.id}' (first occurrence wins)`);
        continue;
      }
      methods[m.id] = { ...m };
    }
  }

  const externalDeps: Record<string, ExternalDepNode> = {};
  const llmCallsByMethod = mergeLlmCalls(input.analyses);
  const methodEdges = buildMethodEdges(
    methods,
    classes,
    input.callees,
    llmCallsByMethod,
    externalDeps,
  );

  applyVerification(methods, classes, input.callees, methodEdges, warnings);

  const classEdges = deriveClassEdges(methodEdges, methods);

  const entryMethodIds = collectEntryMethodIds(classes, methods);
  const boundedContexts = orderedBoundedContexts(classes);
  const readingOrder = buildReadingOrder(entryMethodIds, classes, methods);

  const graph: CodeMapGraph = {
    schemaVersion: 2,
    rootRequest: input.rootRequest,
    scope: input.scope,
    workspaceRoot: input.workspaceRoot,
    rootIntent,
    narrative,
    boundedContexts,
    classes,
    methods,
    externalDeps,
    methodEdges,
    classEdges,
    entryMethodIds,
    readingOrder,
  };

  return { graph, warnings };
}

// -------------------------------------------------------------------------
//   edge construction
// -------------------------------------------------------------------------

interface ResolvedEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  verified: boolean;
}

function buildMethodEdges(
  methods: Record<string, MethodNode>,
  classes: Record<string, ClassNode>,
  callees: ReadonlyMap<string, readonly Callee[]>,
  llmCalls: ReadonlyMap<string, readonly string[]>,
  externalDeps: Record<string, ExternalDepNode>,
): MethodEdge[] {
  const seen = new Set<string>();
  const out: MethodEdge[] = [];

  for (const methodId of Object.keys(methods)) {
    const list = callees.get(methodId);
    if (list && list.length > 0) {
      for (const c of list) {
        const resolved = resolveCallee(methodId, c, methods, classes);
        if (!resolved) continue;
        const key = `${resolved.source}|${resolved.target}|${resolved.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: `e${out.length}`,
          source: resolved.source,
          target: resolved.target,
          kind: resolved.kind,
          verified: resolved.verified,
        });
        if (resolved.target.startsWith('ext:')) {
          registerExternalDep(externalDeps, resolved.target);
        }
      }
      continue;
    }
    // Calibrator did not answer for this method -- fall back to the
    // LLM-declared calls. Edges are stamped verified=false so the
    // verification rollup still flags the method as unverified.
    const tokens = llmCalls.get(methodId);
    if (!tokens || tokens.length === 0) continue;
    for (const token of tokens) {
      const resolved = resolveLlmCallToken(methodId, token, methods, classes);
      if (!resolved) continue;
      const key = `${resolved.source}|${resolved.target}|${resolved.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `e${out.length}`,
        source: resolved.source,
        target: resolved.target,
        kind: resolved.kind,
        verified: false,
      });
      if (resolved.target.startsWith('ext:')) {
        registerExternalDep(externalDeps, resolved.target);
      }
    }
  }
  return out;
}

function mergeLlmCalls(
  analyses: readonly AnalyzeResult[],
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const a of analyses) {
    if (!a.llmCalls) continue;
    for (const [methodId, tokens] of Object.entries(a.llmCalls)) {
      if (out.has(methodId)) continue;
      out.set(methodId, [...tokens]);
    }
  }
  return out;
}

function resolveLlmCallToken(
  sourceMethodId: string,
  token: string,
  methods: Record<string, MethodNode>,
  classes: Record<string, ClassNode>,
): ResolvedEdge | undefined {
  const trimmed = token.trim();
  if (!trimmed) return undefined;
  // Already-namespaced ext targets are passed through verbatim.
  if (trimmed.startsWith('ext:')) {
    return {
      source: sourceMethodId,
      target: trimmed,
      kind: 'external_calls',
      verified: false,
    };
  }
  if (methods[trimmed]) {
    return {
      source: sourceMethodId,
      target: trimmed,
      kind: 'calls',
      verified: false,
    };
  }
  if (classes[trimmed]) {
    return {
      source: sourceMethodId,
      target: trimmed,
      kind: 'calls',
      verified: false,
    };
  }
  const dot = trimmed.lastIndexOf('.');
  if (dot > 0) {
    const cls = trimmed.slice(0, dot);
    if (classes[cls]) {
      return {
        source: sourceMethodId,
        target: cls,
        kind: 'calls',
        verified: false,
      };
    }
  }
  return {
    source: sourceMethodId,
    target: `ext:${trimmed}`,
    kind: 'external_calls',
    verified: false,
  };
}

function resolveCallee(
  sourceMethodId: string,
  c: Callee,
  methods: Record<string, MethodNode>,
  classes: Record<string, ClassNode>,
): ResolvedEdge | undefined {
  if (c.kind === 'constructor' || c.kind === 'localFunction' || c.kind === 'unknown') {
    return undefined;
  }
  const bareClass = bareName(c.containingType);
  const bareMethod = bareName(c.methodName);
  if (!bareMethod) return undefined;

  if (bareClass && methods[`${bareClass}.${bareMethod}`]) {
    return {
      source: sourceMethodId,
      target: `${bareClass}.${bareMethod}`,
      kind: c.isExternal ? 'external_calls' : 'calls',
      verified: true,
    };
  }
  if (bareClass && classes[bareClass]) {
    return {
      source: sourceMethodId,
      target: bareClass,
      kind: c.isExternal ? 'external_calls' : 'calls',
      verified: true,
    };
  }
  const extName = bareClass || bareMethod;
  return {
    source: sourceMethodId,
    target: `ext:${extName}`,
    kind: 'external_calls',
    verified: c.isExternal,
  };
}

function registerExternalDep(
  externalDeps: Record<string, ExternalDepNode>,
  id: string,
): void {
  if (externalDeps[id]) return;
  const name = id.slice(4);
  externalDeps[id] = { id, name, kind: 'package' };
}

// -------------------------------------------------------------------------
//   verification rollup
// -------------------------------------------------------------------------

function applyVerification(
  methods: Record<string, MethodNode>,
  classes: Record<string, ClassNode>,
  callees: ReadonlyMap<string, readonly Callee[]>,
  edges: readonly MethodEdge[],
  warnings: string[],
): void {
  const edgesByOwner = new Map<string, MethodEdge[]>();
  for (const e of edges) {
    let bucket = edgesByOwner.get(e.source);
    if (!bucket) {
      bucket = [];
      edgesByOwner.set(e.source, bucket);
    }
    bucket.push(e);
  }

  for (const methodId of Object.keys(methods)) {
    const m = methods[methodId]!;
    if (!callees.has(methodId)) {
      m.verification = 'unverified';
      continue;
    }
    const owned = edgesByOwner.get(methodId) ?? [];
    if (owned.length === 0) {
      m.verification = 'verified';
      continue;
    }
    m.verification = owned.every((e) => e.verified) ? 'verified' : 'partial';
  }

  for (const classId of Object.keys(classes)) {
    const c = classes[classId]!;
    const owned = c.methodIds.filter((mid) => methods[mid]);
    if (owned.length === 0) {
      c.verification = 'unverified';
      continue;
    }
    const states = new Set<VerificationState>(owned.map((mid) => methods[mid]!.verification));
    c.verification = rollupVerification(states);

    const dropped = collectDroppedTargets(owned, edgesByOwner);
    if (dropped.length > 0) {
      const details: VerificationDetails = c.verificationDetails ?? {
        rangeAdjusted: false,
        droppedTargets: [],
      };
      const merged = new Set([...details.droppedTargets, ...dropped]);
      c.verificationDetails = { ...details, droppedTargets: [...merged] };
    }
  }

  // Surface methods whose owner class was not analyzed -- those leak across
  // BC boundaries and the chat layer needs to know.
  for (const methodId of Object.keys(methods)) {
    const m = methods[methodId]!;
    if (!classes[m.ownerClassId]) {
      warnings.push(`method '${methodId}' has no owner class '${m.ownerClassId}' in graph`);
    }
  }
}

function rollupVerification(states: Set<VerificationState>): VerificationState {
  if (states.size === 1) {
    const only = [...states][0]!;
    return only;
  }
  if (states.has('verified') && !states.has('unverified') && !states.has('partial')) {
    return 'verified';
  }
  if (!states.has('verified') && !states.has('partial')) {
    return 'unverified';
  }
  return 'partial';
}

function collectDroppedTargets(
  ownedMethodIds: readonly string[],
  edgesByOwner: ReadonlyMap<string, MethodEdge[]>,
): string[] {
  const out: string[] = [];
  for (const mid of ownedMethodIds) {
    const edges = edgesByOwner.get(mid) ?? [];
    for (const e of edges) {
      if (!e.verified && e.target.startsWith('ext:')) {
        out.push(e.target.slice(4));
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------------
//   class-edge derivation
// -------------------------------------------------------------------------

function deriveClassEdges(
  methodEdges: readonly MethodEdge[],
  methods: Record<string, MethodNode>,
): ClassEdgeDerived[] {
  const byKey = new Map<string, ClassEdgeDerived>();
  for (const e of methodEdges) {
    const sourceMethod = methods[e.source];
    if (!sourceMethod) continue;
    const sourceClass = sourceMethod.ownerClassId;
    const targetClass = classIdForEdgeTarget(e.target, methods);
    if (sourceClass === targetClass) continue;
    const key = `${sourceClass}|${targetClass}|${e.kind}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.multiplicity += 1;
      existing.verified = existing.verified || e.verified;
      continue;
    }
    byKey.set(key, {
      source: sourceClass,
      target: targetClass,
      kind: e.kind,
      multiplicity: 1,
      verified: e.verified,
    });
  }
  return [...byKey.values()];
}

function classIdForEdgeTarget(
  target: string,
  methods: Record<string, MethodNode>,
): string {
  if (target.startsWith('ext:')) return target;
  const m = methods[target];
  if (m) return m.ownerClassId;
  return target;
}

// -------------------------------------------------------------------------
//   entries + reading order + BC palette
// -------------------------------------------------------------------------

function collectEntryMethodIds(
  classes: Record<string, ClassNode>,
  methods: Record<string, MethodNode>,
): string[] {
  const out: string[] = [];
  for (const id of Object.keys(classes)) {
    const c = classes[id]!;
    if (!c.isEntry) continue;
    for (const mid of c.methodIds) {
      if (methods[mid]) out.push(mid);
    }
  }
  return out;
}

function orderedBoundedContexts(classes: Record<string, ClassNode>): string[] {
  const counts = new Map<string, number>();
  for (const id of Object.keys(classes)) {
    const bc = classes[id]!.boundedContext;
    if (!bc) continue;
    counts.set(bc, (counts.get(bc) ?? 0) + 1);
  }
  const ordered = [...counts.entries()]
    .filter(([bc]) => bc !== 'shared')
    .sort((a, b) => b[1] - a[1])
    .map(([bc]) => bc);
  if (counts.has('shared')) ordered.push('shared');
  return ordered;
}

function buildReadingOrder(
  entryMethodIds: readonly string[],
  classes: Record<string, ClassNode>,
  methods: Record<string, MethodNode>,
): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const mid of entryMethodIds) {
    if (methods[mid] && !seen.has(mid)) {
      order.push(mid);
      seen.add(mid);
    }
  }
  for (const cid of Object.keys(classes)) {
    for (const mid of classes[cid]!.methodIds) {
      if (methods[mid] && !seen.has(mid)) {
        order.push(mid);
        seen.add(mid);
      }
    }
  }
  return order;
}

// -------------------------------------------------------------------------
//   helpers
// -------------------------------------------------------------------------

function bareName(fqn: string): string {
  if (!fqn) return '';
  const generics = fqn.indexOf('<');
  const head = generics >= 0 ? fqn.slice(0, generics) : fqn;
  const dot = head.lastIndexOf('.');
  const plus = head.lastIndexOf('+');
  const cut = Math.max(dot, plus);
  return cut >= 0 ? head.slice(cut + 1) : head;
}
