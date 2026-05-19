import type { CodeMapGraph, CodeNode } from '../shared/types';

/**
 * Pure helpers for the `/why`, `/explain`, and `/focus` chat sub-commands.
 *
 * Kept free of `vscode` imports so they can be unit-tested directly. The
 * chat participant is responsible for shipping the markdown into the response
 * stream and (for `/focus`) for re-rendering the WebView with the subgraph.
 */

export interface WhyResult {
  markdown: string;
  /** True if the target was found; lets the caller surface a hint. */
  found: boolean;
}

export interface ExplainResult {
  markdown: string;
  count: number;
}

export interface FocusResult {
  /** ±1-hop subgraph centered on `target`. Empty when target is missing. */
  subgraph?: CodeMapGraph;
  /** Class ids included (target + direct neighbors). */
  includedIds: string[];
  markdown: string;
  found: boolean;
}

/**
 * Translate one node's `verificationDetails` into prose. Always returns a
 * markdown blob so the caller can `response.markdown(result.markdown)`
 * directly.
 */
export function explainNode(graph: CodeMapGraph, target: string): WhyResult {
  const node = findNodeFuzzy(graph, target);
  if (!node) {
    return {
      found: false,
      markdown:
        `_No class named \`${target}\` is in the current graph._ ` +
        `Re-run \`@codemap generate codemap\` or check the spelling — ` +
        `the match is case-sensitive.`,
    };
  }

  const lines: string[] = [];
  lines.push(`### \`${node.id}\` — ${badge(node.verification)}`);
  lines.push('');
  lines.push(`- **File:** \`${node.file}\` (lines ${node.range.startLine}–${node.range.endLine})`);
  lines.push(`- **Bounded context:** \`${node.boundedContext}\``);
  if (node.layer) lines.push(`- **Layer:** \`${node.layer}\``);
  lines.push(`- **Confidence:** ${(node.confidence ?? 0).toFixed(2)}`);
  if (node.risks.length > 0) {
    lines.push(`- **Risks:** ${node.risks.map(r => `\`${r.type}\``).join(', ')}`);
  }
  lines.push('');

  const v = node.verificationDetails;
  if (node.verification === 'verified' && !v?.rangeAdjusted && !v?.lspNotReady) {
    lines.push(
      'Verification is **clean**. The LSP confirmed both the class location and every in-file call target.',
    );
    return { found: true, markdown: lines.join('\n') };
  }

  if (v?.lspNotReady) {
    lines.push(
      '> ⚠ The language server did not respond at calibration time, so this verification is **provisional**. ' +
        'Re-run `@codemap generate codemap` after the workspace finishes indexing.',
    );
    lines.push('');
  }

  if (v?.rangeAdjusted) {
    lines.push(
      `- **Range adjusted:** the LLM-supplied line range was overridden by the LSP. Jumps now land on the actual class definition (lines ${node.range.startLine}–${node.range.endLine}).`,
    );
  }
  if (v?.droppedCalls && v.droppedCalls.length > 0) {
    lines.push(
      `- **Unresolved \`calls\` targets:** ${v.droppedCalls.map(c => `\`${c}\``).join(', ')}.`,
    );
    lines.push('  These appear in the source but the workspace symbol provider could not find them — the LLM may have hallucinated a name, or the target class is in an excluded folder.');
  }
  if (v?.droppedExternalCalls && v.droppedExternalCalls.length > 0) {
    lines.push(
      `- **Unresolved \`external_calls\`:** ${v.droppedExternalCalls.map(c => `\`${c}\``).join(', ')}.`,
    );
  }
  if (node.verification === 'unverified') {
    lines.push('- The class id was **not** found by `executeWorkspaceSymbolProvider`. The node is shown as a ghost; jumps to source are disabled.');
  }
  if (v?.reason) {
    lines.push('');
    lines.push(`> ${v.reason}`);
  }

  // Outbound unverified edges that don't show in droppedCalls (cross-file
  // path) — surface them too so the user has a complete picture.
  const unresolvedOutbound = graph.edges
    .filter(e => e.from === node.id && !e.verified && e.kind === 'calls')
    .map(e => e.to)
    .filter(to => !(v?.droppedCalls ?? []).includes(to));
  if (unresolvedOutbound.length > 0) {
    lines.push('');
    lines.push(
      `- **Cross-file calls still unverified after aggregation:** ${unresolvedOutbound
        .map(c => `\`${c}\``)
        .join(', ')}.`,
    );
  }

  return { found: true, markdown: lines.join('\n') };
}

/**
 * Build the "explain unverified" report for the whole graph.
 */
export function explainUnverified(graph: CodeMapGraph): ExplainResult {
  const all = Object.values(graph.nodes);
  const partial = all.filter(n => n.verification === 'partial');
  const unverified = all.filter(n => n.verification === 'unverified');

  if (partial.length === 0 && unverified.length === 0) {
    return {
      count: 0,
      markdown: '✓ Every node in the current graph is **verified**. Nothing to explain.',
    };
  }

  const lines: string[] = [];
  lines.push(
    `Current graph has **${unverified.length} unverified** and **${partial.length} partial** node(s).`,
  );
  lines.push('');

  if (unverified.length > 0) {
    lines.push('### Unverified');
    for (const n of unverified.slice(0, 20)) {
      lines.push(`- \`${n.id}\` (\`${n.file}\`) — ${reasonForNode(n)}`);
    }
    if (unverified.length > 20) lines.push(`- _…and ${unverified.length - 20} more_`);
    lines.push('');
  }
  if (partial.length > 0) {
    lines.push('### Partial');
    for (const n of partial.slice(0, 20)) {
      lines.push(`- \`${n.id}\` (\`${n.file}\`) — ${reasonForNode(n)}`);
    }
    if (partial.length > 20) lines.push(`- _…and ${partial.length - 20} more_`);
    lines.push('');
  }
  lines.push('_Use `@codemap /why <Class>` for a per-node breakdown._');

  return { count: partial.length + unverified.length, markdown: lines.join('\n') };
}

/**
 * Build the ±1-hop focus subgraph: target + every node directly connected
 * to it via a `calls` edge in either direction. External edges from the
 * subgraph nodes are preserved; external edges from out-of-subgraph nodes
 * are dropped.
 */
export function focusSubgraph(graph: CodeMapGraph, target: string): FocusResult {
  const node = findNodeFuzzy(graph, target);
  if (!node) {
    return {
      found: false,
      includedIds: [],
      markdown:
        `_No class named \`${target}\` is in the current graph._ ` +
        `Try \`@codemap generate codemap\` first, then \`/focus <Class>\`.`,
    };
  }

  const includedSet = new Set<string>([node.id]);
  for (const e of graph.edges) {
    if (e.kind !== 'calls') continue;
    if (e.from === node.id && graph.nodes[e.to]) includedSet.add(e.to);
    if (e.to === node.id && graph.nodes[e.from]) includedSet.add(e.from);
  }

  const includedIds = Array.from(includedSet);
  const nodes: Record<string, CodeNode> = {};
  for (const id of includedIds) {
    const n = graph.nodes[id];
    if (n) nodes[id] = n;
  }
  const edges = graph.edges.filter(e => {
    if (e.kind === 'external_calls') return includedSet.has(e.from);
    return includedSet.has(e.from) && includedSet.has(e.to);
  });

  const subgraph: CodeMapGraph = {
    rootRequest: `@codemap /focus ${node.id}`,
    scope: `focus:${node.id}`,
    nodes,
    edges,
    externalDeps: graph.externalDeps.filter(d =>
      edges.some(e => e.kind === 'external_calls' && e.to === `ext:${d.name}`),
    ),
    rootIntent: `±1-hop neighborhood of ${node.id}`,
    narrative: graph.narrative,
    suggestedEntryNodes: [node.id],
    readingOrder: includedIds,
  };

  const neighborCount = includedIds.length - 1;
  const md = [
    `### \`/focus ${node.id}\``,
    '',
    `Showing **${node.id}** + **${neighborCount}** direct neighbor(s). ` +
      `${edges.filter(e => e.kind === 'calls').length} call edges, ` +
      `${edges.filter(e => e.kind === 'external_calls').length} external.`,
    '',
    '_The WebView has been re-rendered to this neighborhood. ' +
      'Run `@codemap generate codemap` to restore the full graph._',
  ].join('\n');

  return { found: true, includedIds, subgraph, markdown: md };
}

function findNodeFuzzy(graph: CodeMapGraph, target: string): CodeNode | undefined {
  if (!target) return undefined;
  const direct = graph.nodes[target];
  if (direct) return direct;
  // Case-insensitive fallback so users don't have to remember exact casing.
  const lower = target.toLowerCase();
  for (const n of Object.values(graph.nodes)) {
    if (n.id.toLowerCase() === lower) return n;
  }
  return undefined;
}

function badge(state: CodeNode['verification']): string {
  switch (state) {
    case 'verified':
      return '✓ verified';
    case 'partial':
      return '⚠ partial';
    case 'unverified':
      return '✗ unverified';
  }
}

function reasonForNode(n: CodeNode): string {
  const v = n.verificationDetails;
  if (!v) return 'no calibration details';
  const bits: string[] = [];
  if (v.lspNotReady) bits.push('LSP did not respond');
  if (v.rangeAdjusted) bits.push('range adjusted');
  if (v.droppedCalls && v.droppedCalls.length > 0) {
    bits.push(`${v.droppedCalls.length} unresolved call(s)`);
  }
  if (v.droppedExternalCalls && v.droppedExternalCalls.length > 0) {
    bits.push(`${v.droppedExternalCalls.length} unresolved external(s)`);
  }
  if (v.reason && bits.length === 0) bits.push(v.reason);
  if (bits.length === 0) return 'unknown';
  return bits.join('; ');
}
