import type { CodeMapGraph, CodeNode } from '../shared/types';

/**
 * Computes a recommended reading order for the merged graph.
 *
 * Strategy (v3 §5):
 *   1. Pick entry nodes — anything with `layer === 'entry'` or with no inbound
 *      `calls` edges. Sort entries by descending confidence so the most-trusted
 *      one is read first.
 *   2. DFS from each entry; when expanding children, visit lower-confidence
 *      and higher-risk children first so reviewers see the "scary" code early.
 *   3. Append any node not reachable from an entry (orphans / cycles) at the
 *      end, sorted by `readingPriority` if the LLM provided one.
 *
 * Output is the list of node ids in suggested reading order. The function is
 * pure — it does not mutate the graph.
 */
export function computeReadingOrder(graph: CodeMapGraph): string[] {
  const nodes = Object.values(graph.nodes);
  if (nodes.length === 0) return [];

  const inboundCalls = new Map<string, number>();
  for (const id of Object.keys(graph.nodes)) inboundCalls.set(id, 0);
  for (const edge of graph.edges) {
    if (edge.kind !== 'calls') continue;
    if (!graph.nodes[edge.to]) continue; // skip dangling edges to external deps
    inboundCalls.set(edge.to, (inboundCalls.get(edge.to) ?? 0) + 1);
  }

  const entries = nodes
    .filter(n => n.layer === 'entry' || (inboundCalls.get(n.id) ?? 0) === 0)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .map(n => n.id);

  const order: string[] = [];
  const visited = new Set<string>();

  // Build an adjacency list once for stable child ordering.
  const childrenOf = new Map<string, CodeNode[]>();
  for (const id of Object.keys(graph.nodes)) childrenOf.set(id, []);
  for (const edge of graph.edges) {
    if (edge.kind !== 'calls') continue;
    const child = graph.nodes[edge.to];
    if (!child) continue;
    childrenOf.get(edge.from)?.push(child);
  }

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    order.push(id);
    const children = (childrenOf.get(id) ?? [])
      .slice()
      .sort((a, b) => {
        // Higher risk first, then lower confidence first.
        const riskDelta = (b.risks?.length ?? 0) - (a.risks?.length ?? 0);
        if (riskDelta !== 0) return riskDelta;
        return (a.confidence ?? 1) - (b.confidence ?? 1);
      });
    for (const child of children) visit(child.id);
  };

  for (const entryId of entries) visit(entryId);

  // Append orphans / cycle-only nodes, in LLM-suggested priority order.
  const orphans = nodes
    .filter(n => !visited.has(n.id))
    .sort((a, b) => (a.readingPriority ?? 99) - (b.readingPriority ?? 99));
  for (const o of orphans) visit(o.id);

  return order;
}
