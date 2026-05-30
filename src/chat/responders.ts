// Phase 3.3b -- pure markdown renderers for /why, /explain, /focus,
// /entries chat sub-commands. Operates on a v2 CodeMapGraph; no vscode
// imports so the file is unit-testable in isolation. The participant
// owns wiring these into the chat stream and re-rendering the webview.

import type {
  ClassNode,
  CodeMapGraph,
  EdgeKind,
  EntryKind,
  MethodEdge,
  MethodNode,
  VerificationState,
} from '../shared/types';

// =========================================================================
//   /why <Class>
// =========================================================================

export interface WhyResult {
  markdown: string;
  found: boolean;
}

export function explainClass(graph: CodeMapGraph, target: string): WhyResult {
  const cls = findClassFuzzy(graph, target);
  if (!cls) {
    return {
      found: false,
      markdown:
        `_No class named \`${target}\` is in the current graph._ ` +
        'Re-run `@codemap generate codemap` or check the spelling.',
    };
  }

  const lines: string[] = [];
  lines.push(`### \`${cls.id}\` -- ${badge(cls.verification)}`);
  lines.push('');
  lines.push(`- **File:** \`${cls.file}\` (lines ${cls.range.startLine}-${cls.range.endLine})`);
  lines.push(`- **Bounded context:** \`${cls.boundedContext}\``);
  if (cls.layer) lines.push(`- **Layer:** \`${cls.layer}\``);
  lines.push(`- **Confidence:** ${(cls.confidence ?? 0).toFixed(2)}`);
  if (cls.risks.length > 0) {
    lines.push(`- **Risks:** ${cls.risks.map((r) => `\`${r.type}\``).join(', ')}`);
  }
  lines.push('');

  const v = cls.verificationDetails;
  if (cls.verification === 'verified' && !v?.rangeAdjusted && !v?.lspNotReady) {
    lines.push(
      'Verification is **clean**. The calibrator confirmed every callee in this class.',
    );
    return { found: true, markdown: lines.join('\n') };
  }

  if (v?.lspNotReady) {
    lines.push(
      '> WARN The calibrator did not respond at analysis time, so this verification is **provisional**. ' +
        'Re-run `@codemap generate codemap` after the workspace finishes indexing.',
    );
    lines.push('');
  }

  if (v?.rangeAdjusted) {
    lines.push(
      `- **Range adjusted:** the calibrator overrode the LLM-supplied class range (lines ${cls.range.startLine}-${cls.range.endLine}).`,
    );
  }
  if (v?.droppedTargets && v.droppedTargets.length > 0) {
    lines.push(
      `- **Unresolved targets:** ${v.droppedTargets.map((c) => `\`${c}\``).join(', ')}.`,
    );
    lines.push(
      '  These callees appear in the source but the calibrator could not match them to a class in scope -- they may be hallucinated, in an excluded folder, or in a project the calibrator did not load.',
    );
  }
  if (cls.verification === 'unverified') {
    lines.push('- The calibrator could not answer for any method on this class. Edges are absent and jumps to source are disabled.');
  }
  if (v?.reason) {
    lines.push('');
    lines.push(`> ${v.reason}`);
  }

  const unresolvedOutbound = collectUnresolvedClassEdges(graph, cls.id, v?.droppedTargets ?? []);
  if (unresolvedOutbound.length > 0) {
    lines.push('');
    lines.push(
      `- **Cross-file calls still unverified after aggregation:** ${unresolvedOutbound
        .map((c) => `\`${c}\``)
        .join(', ')}.`,
    );
  }

  return { found: true, markdown: lines.join('\n') };
}

function collectUnresolvedClassEdges(
  graph: CodeMapGraph,
  classId: string,
  alreadyListed: readonly string[],
): string[] {
  const seenAlready = new Set(alreadyListed);
  const out = new Set<string>();
  for (const e of graph.classEdges) {
    if (e.source !== classId) continue;
    if (e.verified) continue;
    if (e.kind !== 'calls') continue;
    if (seenAlready.has(e.target)) continue;
    out.add(e.target);
  }
  return [...out];
}

// =========================================================================
//   /explain unverified
// =========================================================================

export interface ExplainResult {
  markdown: string;
  count: number;
}

export function explainUnverified(graph: CodeMapGraph): ExplainResult {
  const all = Object.values(graph.classes);
  const partial = all.filter((n) => n.verification === 'partial');
  const unverified = all.filter((n) => n.verification === 'unverified');

  if (partial.length === 0 && unverified.length === 0) {
    return {
      count: 0,
      markdown: 'OK Every class in the current graph is **verified**. Nothing to explain.',
    };
  }

  const lines: string[] = [];
  lines.push(
    `Current graph has **${unverified.length} unverified** and **${partial.length} partial** class(es).`,
  );
  lines.push('');

  if (unverified.length > 0) {
    lines.push('### Unverified');
    for (const n of unverified.slice(0, 20)) {
      lines.push(`- \`${n.id}\` (\`${n.file}\`) -- ${reasonForClass(n)}`);
    }
    if (unverified.length > 20) lines.push(`- _...and ${unverified.length - 20} more_`);
    lines.push('');
  }
  if (partial.length > 0) {
    lines.push('### Partial');
    for (const n of partial.slice(0, 20)) {
      lines.push(`- \`${n.id}\` (\`${n.file}\`) -- ${reasonForClass(n)}`);
    }
    if (partial.length > 20) lines.push(`- _...and ${partial.length - 20} more_`);
    lines.push('');
  }
  lines.push('_Use `@codemap /why <Class>` for a per-class breakdown._');

  return { count: partial.length + unverified.length, markdown: lines.join('\n') };
}

// =========================================================================
//   /focus <Class>
// =========================================================================

export interface FocusResult {
  /** Class-level +/-1-hop subgraph centered on target. Undefined when missing. */
  subgraph?: CodeMapGraph;
  /** Class ids included (target + direct neighbors). */
  includedClassIds: string[];
  markdown: string;
  found: boolean;
}

export function focusSubgraph(graph: CodeMapGraph, target: string): FocusResult {
  const cls = findClassFuzzy(graph, target);
  if (!cls) {
    return {
      found: false,
      includedClassIds: [],
      markdown:
        `_No class named \`${target}\` is in the current graph._ ` +
        'Try `@codemap generate codemap` first, then `/focus <Class>`.',
    };
  }

  const includedSet = new Set<string>([cls.id]);
  for (const e of graph.classEdges) {
    if (e.kind !== 'calls') continue;
    if (e.source === cls.id && graph.classes[e.target]) includedSet.add(e.target);
    if (e.target === cls.id && graph.classes[e.source]) includedSet.add(e.source);
  }
  const includedClassIds = [...includedSet];

  const classes: Record<string, ClassNode> = {};
  for (const id of includedClassIds) {
    const c = graph.classes[id];
    if (c) classes[id] = c;
  }

  const methods: Record<string, MethodNode> = {};
  for (const m of Object.values(graph.methods)) {
    if (includedSet.has(m.ownerClassId)) methods[m.id] = m;
  }

  const methodEdges = graph.methodEdges.filter((e) => {
    if (!methods[e.source]) return false;
    if (e.kind === 'external_calls') return true;
    if (methods[e.target]) return true;
    return includedSet.has(e.target);
  });

  const classEdges = deriveClassEdges(methodEdges, methods);

  const externalDeps: Record<string, typeof graph.externalDeps[string]> = {};
  for (const e of methodEdges) {
    if (e.target.startsWith('ext:')) {
      const dep = graph.externalDeps[e.target];
      if (dep) externalDeps[e.target] = dep;
    }
  }

  const entryMethodIds = graph.entryMethodIds.filter((mid) => methods[mid]);
  const boundedContexts = orderedBoundedContexts(classes);

  const subgraph: CodeMapGraph = {
    schemaVersion: 2,
    rootRequest: `@codemap /focus ${cls.id}`,
    scope: `focus:${cls.id}`,
    workspaceRoot: graph.workspaceRoot,
    rootIntent: `+/-1-hop neighborhood of ${cls.id}`,
    narrative: graph.narrative,
    boundedContexts,
    classes,
    methods,
    externalDeps,
    methodEdges,
    classEdges,
    entryMethodIds,
    readingOrder: includedClassIds.flatMap((id) => graph.classes[id]?.methodIds ?? []).filter((mid) => methods[mid]),
  };

  const neighborCount = includedClassIds.length - 1;
  const md = [
    `### \`/focus ${cls.id}\``,
    '',
    `Showing **${cls.id}** + **${neighborCount}** direct neighbor(s). ` +
      `${methodEdges.filter((e) => e.kind === 'calls').length} call edges, ` +
      `${methodEdges.filter((e) => e.kind === 'external_calls').length} external.`,
    '',
    '_The WebView has been re-rendered to this neighborhood. ' +
      'Run `@codemap generate codemap` to restore the full graph._',
  ].join('\n');

  return { found: true, includedClassIds, subgraph, markdown: md };
}

function deriveClassEdges(
  methodEdges: readonly MethodEdge[],
  methods: Record<string, MethodNode>,
): CodeMapGraph['classEdges'] {
  const byKey = new Map<string, CodeMapGraph['classEdges'][number]>();
  for (const e of methodEdges) {
    const src = methods[e.source];
    if (!src) continue;
    const targetClass = classIdForEdgeTarget(e.target, methods);
    if (src.ownerClassId === targetClass) continue;
    const key = `${src.ownerClassId}|${targetClass}|${e.kind}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.multiplicity += 1;
      existing.verified = existing.verified || e.verified;
      continue;
    }
    byKey.set(key, {
      source: src.ownerClassId,
      target: targetClass,
      kind: e.kind,
      multiplicity: 1,
      verified: e.verified,
    });
  }
  return [...byKey.values()];
}

function classIdForEdgeTarget(target: string, methods: Record<string, MethodNode>): string {
  const m = methods[target];
  if (m) return m.ownerClassId;
  return target;
}

function orderedBoundedContexts(classes: Record<string, ClassNode>): string[] {
  const freq = new Map<string, number>();
  for (const c of Object.values(classes)) {
    if (!c.boundedContext) continue;
    freq.set(c.boundedContext, (freq.get(c.boundedContext) ?? 0) + 1);
  }
  const entries = [...freq.entries()];
  entries.sort((a, b) => {
    if (a[0] === 'shared' && b[0] !== 'shared') return 1;
    if (b[0] === 'shared' && a[0] !== 'shared') return -1;
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  return entries.map((e) => e[0]);
}

// =========================================================================
//   Verification digest (printed under the /generate summary)
// =========================================================================

export function formatVerificationDigest(
  graph: CodeMapGraph,
  maxItems = 10,
): string | undefined {
  const all = Object.values(graph.classes);
  const partial = all.filter((n) => n.verification === 'partial');
  const unverified = all.filter((n) => n.verification === 'unverified');
  if (partial.length + unverified.length === 0) return undefined;

  const lines: string[] = [];
  const summaryBits: string[] = [];
  if (partial.length > 0) summaryBits.push(`${partial.length} partial`);
  if (unverified.length > 0) summaryBits.push(`${unverified.length} unverified`);
  lines.push(`**Why ${summaryBits.join(' / ')}?**`);
  lines.push('');

  if (partial.length > 0) {
    for (const n of partial.slice(0, maxItems)) {
      lines.push(`- WARN \`${n.id}\` (\`${n.file}\`) -- ${reasonForClass(n)}`);
    }
    if (partial.length > maxItems) {
      lines.push(`- _...and ${partial.length - maxItems} more partial_`);
    }
  }
  if (unverified.length > 0) {
    for (const n of unverified.slice(0, maxItems)) {
      lines.push(`- MISS \`${n.id}\` (\`${n.file}\`) -- ${reasonForClass(n)}`);
    }
    if (unverified.length > maxItems) {
      lines.push(`- _...and ${unverified.length - maxItems} more unverified_`);
    }
  }
  lines.push('');
  lines.push('_Use `@codemap /why <Class>` for a per-class breakdown._');
  return lines.join('\n');
}

// =========================================================================
//   /entries
// =========================================================================

export interface EntriesResult {
  markdown: string;
  count: number;
}

const ENTRY_KIND_ORDER: readonly EntryKind[] = [
  'http_endpoint',
  'cli_main',
  'worker',
  'sample',
  'public_api',
];

const ENTRY_KIND_LABEL: Record<EntryKind, string> = {
  http_endpoint: 'HTTP endpoints',
  cli_main: 'CLI mains',
  worker: 'Workers',
  sample: 'Samples',
  public_api: 'Public APIs',
};

export function listEntries(graph: CodeMapGraph): EntriesResult {
  // v2 carries entries at the class level (isEntry/entryKind/entryMeta) and
  // also surfaces entry method ids in graph.entryMethodIds. The user-facing
  // list is the class set; method ids are only useful as a sanity check.
  const entries = Object.values(graph.classes).filter((c) => c.isEntry === true);

  if (entries.length === 0) {
    return {
      count: 0,
      markdown:
        '_No entry-point classes tagged in the current graph._ ' +
        'Either the workspace has no user-facing entry points, or the LLM ' +
        'did not surface any. Re-run `@codemap /scope <path>` to retry.',
    };
  }

  const byKind = new Map<EntryKind | 'unknown', ClassNode[]>();
  for (const n of entries) {
    const k = (n.entryKind ?? 'unknown') as EntryKind | 'unknown';
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k)!.push(n);
  }

  const lines: string[] = [];
  lines.push(
    `Found **${entries.length}** entry-point class(es) across **${byKind.size}** kind(s).`,
  );
  lines.push('');

  for (const kind of ENTRY_KIND_ORDER) {
    const ns = byKind.get(kind);
    if (!ns || ns.length === 0) continue;
    lines.push(`### ${ENTRY_KIND_LABEL[kind]} (${ns.length})`);
    for (const n of ns) lines.push(formatEntryLine(n));
    lines.push('');
  }

  const unknown = byKind.get('unknown');
  if (unknown && unknown.length > 0) {
    lines.push(`### Tagged \`isEntry\` without a recognized kind (${unknown.length})`);
    for (const n of unknown) lines.push(formatEntryLine(n));
    lines.push('');
  }

  lines.push("_Use `@codemap /focus <Class>` to see an entry's subgraph._");
  return { count: entries.length, markdown: lines.join('\n') };
}

function formatEntryLine(n: ClassNode): string {
  const bits: string[] = [];
  const meta = n.entryMeta;
  if (meta?.routes && meta.routes.length > 0) {
    bits.push(meta.routes.map((r) => `\`${r}\``).join(', '));
  }
  if (meta?.commands && meta.commands.length > 0) {
    bits.push(`cmds: ${meta.commands.map((c) => `\`${c}\``).join(', ')}`);
  }
  if (meta?.sampleName) bits.push(`sample: \`${meta.sampleName}\``);
  if (meta?.publicApis && meta.publicApis.length > 0) {
    const shown = meta.publicApis.slice(0, 4).map((a) => `\`${a}\``).join(', ');
    const tail =
      meta.publicApis.length > 4 ? ` _(+${meta.publicApis.length - 4} more)_` : '';
    bits.push(`apis: ${shown}${tail}`);
  }
  const suffix = bits.length > 0 ? ` -- ${bits.join(' / ')}` : '';
  return `- \`${n.id}\` (\`${n.file}\`)${suffix}`;
}

// =========================================================================
//   shared helpers
// =========================================================================

function findClassFuzzy(graph: CodeMapGraph, target: string): ClassNode | undefined {
  if (!target) return undefined;
  const direct = graph.classes[target];
  if (direct) return direct;
  const lower = target.toLowerCase();
  for (const c of Object.values(graph.classes)) {
    if (c.id.toLowerCase() === lower) return c;
  }
  return undefined;
}

function badge(state: VerificationState): string {
  switch (state) {
    case 'verified':
      return 'OK verified';
    case 'partial':
      return 'WARN partial';
    case 'unverified':
      return 'MISS unverified';
  }
}

function reasonForClass(n: ClassNode): string {
  const v = n.verificationDetails;
  if (!v) return 'no calibration details';
  const bits: string[] = [];
  if (v.lspNotReady) bits.push('calibrator not ready');
  if (v.rangeAdjusted) bits.push('range adjusted');
  if (v.droppedTargets && v.droppedTargets.length > 0) {
    bits.push(`${v.droppedTargets.length} unresolved target(s)`);
  }
  if (v.reason && bits.length === 0) bits.push(v.reason);
  if (bits.length === 0) return 'unknown';
  return bits.join('; ');
}

// Re-exports for type-only callers that don't want to pull from shared/types.
export type { EdgeKind };
