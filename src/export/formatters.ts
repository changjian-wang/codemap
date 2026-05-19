import type { CodeMapGraph } from '../shared/types';

/**
 * Pure formatters for the three export targets. Kept side-effect free so
 * the host module just picks one + writes the returned string to disk.
 */

export type ExportFormat = 'json' | 'markdown' | 'mermaid';

export interface ExportSpec {
  format: ExportFormat;
  /** Suggested file extension, no leading dot. */
  extension: string;
  /** Display label for the QuickPick. */
  label: string;
  /** Short description for the QuickPick. */
  description: string;
}

export const EXPORT_SPECS: Record<ExportFormat, ExportSpec> = {
  json: {
    format: 'json',
    extension: 'json',
    label: 'JSON',
    description: 'Full graph (lossless, for LLM / programmatic re-consumption)',
  },
  markdown: {
    format: 'markdown',
    extension: 'md',
    label: 'Markdown',
    description: 'Human-readable reading guide ordered by priority',
  },
  mermaid: {
    format: 'mermaid',
    extension: 'mmd',
    label: 'Mermaid',
    description: 'classDiagram for embedding in docs',
  },
};

export function formatGraph(graph: CodeMapGraph, format: ExportFormat): string {
  switch (format) {
    case 'json':
      return formatJson(graph);
    case 'markdown':
      return formatMarkdown(graph);
    case 'mermaid':
      return formatMermaid(graph);
  }
}

// ---------- JSON ----------

function formatJson(graph: CodeMapGraph): string {
  return JSON.stringify(graph, null, 2);
}

// ---------- Markdown ----------

function formatMarkdown(graph: CodeMapGraph): string {
  const lines: string[] = [];
  lines.push(`# CodeMap — ${graph.scope}`);
  lines.push('');
  lines.push(`> Request: \`${graph.rootRequest}\``);
  if (graph.rootIntent) {
    lines.push('');
    lines.push(`_${graph.rootIntent}_`);
  }
  lines.push('');

  const nodes = Object.values(graph.nodes);
  const verified = nodes.filter(n => n.verification === 'verified').length;
  const partial = nodes.filter(n => n.verification === 'partial').length;
  const unverified = nodes.filter(n => n.verification === 'unverified').length;
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **${nodes.length}** classes, **${graph.edges.length}** call edges`);
  lines.push(`- Verification: ✓ ${verified} verified · ⚠ ${partial} partial · ✗ ${unverified} unverified`);
  if (graph.externalDeps.length > 0) {
    lines.push(`- External deps: ${graph.externalDeps.map(d => `\`${d.name}\``).join(', ')}`);
  }
  if (graph.eval) {
    const en = graph.eval.nodes;
    const ee = graph.eval.edges;
    lines.push(
      `- Eval: nodes F1=${en.f1.toFixed(2)} (P=${en.precision.toFixed(2)} R=${en.recall.toFixed(2)}) · ` +
        `edges F1=${ee.f1.toFixed(2)} (P=${ee.precision.toFixed(2)} R=${ee.recall.toFixed(2)})`,
    );
  }
  lines.push('');

  // Reading order section: sort by readingPriority then by id for stability.
  lines.push('## Reading Order');
  lines.push('');
  const sortedNodes = [...nodes].sort((a, b) => {
    const ap = a.readingPriority ?? 99;
    const bp = b.readingPriority ?? 99;
    if (ap !== bp) return ap - bp;
    return a.id.localeCompare(b.id);
  });
  for (const n of sortedNodes) {
    const order = n.readingPriority === undefined || n.readingPriority === 99 ? '—' : `#${n.readingPriority}`;
    const verIcon = n.verification === 'verified' ? '✓' : n.verification === 'partial' ? '⚠' : '✗';
    lines.push(`### ${order} ${verIcon} \`${n.id}\``);
    lines.push('');
    lines.push(`- **File**: \`${n.file}\` (L${n.range.startLine}–L${n.range.endLine})`);
    lines.push(`- **Bounded context**: \`${n.boundedContext}\``);
    if (n.layer) lines.push(`- **Layer**: \`${n.layer}\``);
    lines.push(`- **Confidence**: ${(n.confidence * 100).toFixed(0)}%`);
    if (n.intent) {
      lines.push('');
      lines.push(n.intent);
    }
    if (n.risks.length > 0) {
      lines.push('');
      lines.push(`**Risks**:`);
      for (const r of n.risks) lines.push(`- \`${r.type}\` — ${r.desc}`);
    }
    if (n.methods.length > 0) {
      lines.push('');
      lines.push('**Methods**:');
      for (const m of n.methods) {
        const tag = (m.risks ?? []).length > 0 ? ` _(${m.risks.join(', ')})_` : '';
        lines.push(`- \`${m.signature}\`${tag}`);
        if (m.intent) lines.push(`  - ${m.intent}`);
      }
    }
    lines.push('');
  }

  // Edges section: grouped by from-node so it reads like an outline.
  if (graph.edges.length > 0) {
    lines.push('## Call Graph');
    lines.push('');
    const byFrom = new Map<string, typeof graph.edges>();
    for (const e of graph.edges) {
      const arr = byFrom.get(e.from) ?? [];
      arr.push(e);
      byFrom.set(e.from, arr);
    }
    const fromIds = [...byFrom.keys()].sort();
    for (const from of fromIds) {
      lines.push(`- \`${from}\``);
      for (const e of byFrom.get(from)!) {
        const arrow = e.kind === 'external_calls' ? '⇢' : '→';
        const verMark = e.verified ? '' : ' _(unverified)_';
        lines.push(`  - ${arrow} \`${e.to}\`${verMark}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------- Mermaid ----------

/**
 * Mermaid `classDiagram` output. Node names are sanitized to a Mermaid-safe
 * identifier (alphanumeric + `_`); the original id is preserved via a label
 * stereotype so the diagram round-trips back to the source classes.
 *
 * Edges:
 *   - `calls`           → solid arrow `-->`
 *   - `external_calls`  → dashed arrow `..>`
 *
 * Unverified nodes are tagged with the `<<unverified>>` stereotype so they
 * stay visually distinct after copy-paste into docs that don't carry CSS.
 */
function formatMermaid(graph: CodeMapGraph): string {
  const lines: string[] = [];
  lines.push('classDiagram');
  if (graph.rootIntent) {
    lines.push(`%% ${graph.rootIntent.replace(/\r?\n/g, ' ')}`);
  }
  lines.push(`%% scope: ${graph.scope}`);

  const nodes = Object.values(graph.nodes);
  const idMap = new Map<string, string>();
  for (const n of nodes) idMap.set(n.id, mermaidSafe(n.id));

  for (const n of nodes) {
    const safe = idMap.get(n.id)!;
    const stereotype =
      n.verification === 'unverified'
        ? ' <<unverified>>'
        : n.verification === 'partial'
          ? ' <<partial>>'
          : '';
    if (n.id !== safe) {
      // Mermaid label syntax `class Foo["Foo.Bar"]` preserves the real id.
      lines.push(`class ${safe}["${escapeMermaidLabel(n.id)}"]${stereotype}`);
    } else if (stereotype) {
      lines.push(`class ${safe}${stereotype}`);
    } else {
      lines.push(`class ${safe}`);
    }
    // Up to first 6 methods to keep the diagram readable.
    const ms = n.methods.slice(0, 6);
    for (const m of ms) {
      lines.push(`${safe} : +${escapeMermaidLabel(m.signature)}`);
    }
    if (n.methods.length > ms.length) {
      lines.push(`${safe} : +… ${n.methods.length - ms.length} more`);
    }
  }

  for (const e of graph.edges) {
    const from = idMap.get(e.from);
    const to = idMap.get(e.to);
    if (!from || !to) continue; // Unknown endpoint — skip rather than render a ghost.
    const arrow = e.kind === 'external_calls' ? '..>' : '-->';
    const verLabel = e.verified ? '' : ' : unverified';
    lines.push(`${from} ${arrow} ${to}${verLabel}`);
  }

  return lines.join('\n');
}

function mermaidSafe(id: string): string {
  // Mermaid class ids must be `[A-Za-z][A-Za-z0-9_]*`. Replace anything else
  // with `_`. The original id is preserved in the label.
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[A-Za-z]/.test(cleaned)) return cleaned;
  return `n_${cleaned}`;
}

function escapeMermaidLabel(s: string): string {
  return s.replace(/"/g, "'");
}
