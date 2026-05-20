import type { CodeMapGraph } from '../shared/types';
import type { GoldenSample } from './score';

/**
 * Snapshot the current graph into a {@link GoldenSample} so the user can
 * stash it as a regression baseline. Distinct from the LLM-driven
 * orchestrator path: this is a pure projection that turns "what the LLM
 * just produced and you decided is correct enough" into "the expected
 * answer for future runs".
 *
 * Choices:
 *  - We only include nodes from the (optional) caller-supplied scope file
 *    prefixes. When none is passed, every node is included.
 *  - Edges keep `calls` + `external_calls` (the only kinds {@link scoreGraph}
 *    looks at); we drop `contains` so the golden stays focused on behavior.
 *  - We strip everything else (intent, methods, risks, …) — they're useful
 *    in the live graph but noisy in a golden file the user is supposed to
 *    hand-edit.
 */
export function graphToGolden(
  graph: CodeMapGraph,
  options: { name: string; description?: string; scopeFiles?: string[] },
): GoldenSample {
  const scopeFiles = options.scopeFiles && options.scopeFiles.length > 0
    ? options.scopeFiles
    : undefined;

  const inScope = (file: string): boolean =>
    !scopeFiles || scopeFiles.some(s => file.startsWith(s));

  const nodeIds: string[] = [];
  const includedIds = new Set<string>();
  for (const n of Object.values(graph.nodes)) {
    if (!inScope(n.file)) continue;
    if (!includedIds.has(n.id)) {
      includedIds.add(n.id);
      nodeIds.push(n.id);
    }
  }
  nodeIds.sort();

  const edges: GoldenSample['edges'] = [];
  const seen = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind !== 'calls' && e.kind !== 'external_calls') continue;
    // Only keep edges whose `from` is in scope; `to` may legitimately be an
    // external `ext:*` reference that lives outside the scope.
    if (!includedIds.has(e.from)) continue;
    const key = `${e.from}|${e.to}|${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(e.kind === 'calls' ? { from: e.from, to: e.to } : { from: e.from, to: e.to, kind: 'external_calls' });
  }
  edges.sort((a, b) => {
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    return a.to.localeCompare(b.to);
  });

  return {
    name: options.name,
    description: options.description,
    scopeFiles,
    nodes: nodeIds,
    edges,
  };
}

/** Pretty-print a golden for writing to disk; stable key order across versions
 *  so diffs in PRs stay readable. */
export function stringifyGolden(g: GoldenSample): string {
  const ordered: Record<string, unknown> = {
    name: g.name,
  };
  if (g.description !== undefined) ordered.description = g.description;
  if (g.scopeFiles !== undefined) ordered.scopeFiles = g.scopeFiles;
  ordered.nodes = g.nodes;
  ordered.edges = g.edges;
  return JSON.stringify(ordered, null, 2) + '\n';
}
