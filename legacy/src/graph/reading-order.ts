import type { CodeMapGraph, CodeNode } from '../shared/types';

/**
 * Identifies test classes by file convention. Test entry nodes are demoted
 * below production entries in the reading order — a reviewer wants to see
 * `FileSearchBackend` before `TestFileSearchIntegration`.
 *
 * Conservative: only matches directory segments (`/test(s)/`, `/__tests__/`,
 * `/spec(s)/`) and well-known filename patterns. Avoids matching `testing.py`
 * or other utility files that happen to contain "test" in the name.
 */
export function isTestNode(node: CodeNode): boolean {
  const file = node.file.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(tests?|__tests__|specs?)\//.test(file)) return true;
  const base = file.slice(file.lastIndexOf('/') + 1);
  // Python: test_foo.py / foo_test.py; JS/TS: foo.test.ts / foo.spec.ts;
  // .NET / Java: FooTests.cs / FooTest.java.
  return /(^test_|_test\.|\.test\.|\.spec\.|tests?\.[a-z]+$)/.test(base);
}

/**
 * Hard signal: file-name convention for entry-style files. We rank entry
 * candidates by these tiers so that a true root (`Program.cs`, `Startup.cs`,
 * `main.go`, `index.ts`, `App.tsx`) outranks a routing surface
 * (`*Endpoints.cs`, `*Controller.cs`, `*Handler.cs`) when both qualify as
 * graph entries by in-degree 0 or `layer: 'entry'`.
 *
 *   0 → conventional language/framework root.
 *   1 → ordinary file (no signal either way).
 *   2 → known routing surface that, by convention, is called from a root.
 *
 * Lower number ranks earlier in the reading order.
 */
export function entryFilePriority(node: CodeNode): number {
  const file = node.file.replace(/\\/g, '/').toLowerCase();
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (/^(program|startup|main|app|index)\.[a-z]+$/.test(base)) return 0;
  if (/(endpoint|controller|handler|router|route)s?\.[a-z]+$/.test(base)) return 2;
  return 1;
}

/**
 * Computes a recommended reading order for the merged graph.
 *
 * Strategy (v3 §5):
 *   1. Pick entry nodes — anything with `layer === 'entry'` or with no inbound
 *      `calls` edges. Sort entries by (production-first, descending confidence)
 *      so trusted production code leads and test classes follow.
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
  const outboundCalls = new Map<string, number>();
  for (const id of Object.keys(graph.nodes)) {
    inboundCalls.set(id, 0);
    outboundCalls.set(id, 0);
  }
  for (const edge of graph.edges) {
    if (edge.kind !== 'calls') continue;
    if (!graph.nodes[edge.to]) continue; // skip dangling edges to external deps
    inboundCalls.set(edge.to, (inboundCalls.get(edge.to) ?? 0) + 1);
    outboundCalls.set(edge.from, (outboundCalls.get(edge.from) ?? 0) + 1);
  }

  // Entry sort order, in priority:
  //   1. Production before test (reviewer reads real code first).
  //   2. File-name convention (`Program.cs`/`Startup.cs`/`main.go`/...
  //      outranks `*Endpoints.cs`/`*Controller.cs`/...). Both qualify as
  //      graph entries by in-degree 0, but a routing surface is called
  //      from the root by convention even if the LLM didn't list it.
  //   3. True topological roots (in-degree 0) before layer:entry-but-called.
  //   4. Wider out-degree first — a root that wires many things up beats a
  //      root that wires one or two.
  //   5. Confidence as final tiebreaker.
  const entries = nodes
    .filter(n => n.layer === 'entry' || (inboundCalls.get(n.id) ?? 0) === 0)
    .sort((a, b) => {
      const aTest = isTestNode(a) ? 1 : 0;
      const bTest = isTestNode(b) ? 1 : 0;
      if (aTest !== bTest) return aTest - bTest;
      const aFile = entryFilePriority(a);
      const bFile = entryFilePriority(b);
      if (aFile !== bFile) return aFile - bFile;
      const aIn = inboundCalls.get(a.id) ?? 0;
      const bIn = inboundCalls.get(b.id) ?? 0;
      if (aIn !== bIn) return aIn - bIn;
      const aOut = outboundCalls.get(a.id) ?? 0;
      const bOut = outboundCalls.get(b.id) ?? 0;
      if (aOut !== bOut) return bOut - aOut;
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    })
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
