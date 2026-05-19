import { describe, it, expect } from 'vitest';
import type { CodeMapGraph } from '../../src/shared/types';
import { formatGraph } from '../../src/export/formatters';

function makeGraph(overrides: Partial<CodeMapGraph> = {}): CodeMapGraph {
  return {
    rootRequest: '@codemap generate codemap',
    scope: 'workspace',
    rootIntent: 'Test intent',
    nodes: {
      Foo: {
        id: 'Foo',
        kind: 'class',
        file: 'src/Foo.cs',
        range: { startLine: 10, endLine: 50 },
        boundedContext: 'capture',
        intent: 'Captures events.',
        layer: 'service',
        confidence: 0.9,
        risks: [{ type: 'security', desc: 'auth header read' }],
        methods: [
          {
            name: 'Run',
            signature: 'Run(CancellationToken)',
            line: 15,
            risks: ['concurrency'],
            intent: 'Worker loop.',
          },
        ],
        readingPriority: 1,
        readState: 'unread',
        verification: 'verified',
      },
      'Bar.Baz': {
        id: 'Bar.Baz',
        kind: 'class',
        file: 'src/Bar/Baz.cs',
        range: { startLine: 1, endLine: 20 },
        boundedContext: 'recall',
        intent: 'Recalls events.',
        confidence: 0.7,
        risks: [],
        methods: [],
        readingPriority: 2,
        readState: 'unread',
        verification: 'unverified',
      },
    },
    edges: [
      { from: 'Foo', to: 'Bar.Baz', kind: 'calls', verified: true },
      { from: 'Foo', to: 'ExternalLib', kind: 'external_calls', verified: false },
    ],
    externalDeps: [{ name: 'ExternalLib', kind: 'package' }],
    ...overrides,
  };
}

describe('formatGraph: JSON', () => {
  it('round-trips through JSON.parse', () => {
    const g = makeGraph();
    const out = formatGraph(g, 'json');
    const parsed = JSON.parse(out);
    expect(parsed.scope).toBe('workspace');
    expect(Object.keys(parsed.nodes).sort()).toEqual(['Bar.Baz', 'Foo']);
    expect(parsed.edges.length).toBe(2);
  });
});

describe('formatGraph: Markdown', () => {
  it('orders nodes by readingPriority', () => {
    const out = formatGraph(makeGraph(), 'markdown');
    const fooIdx = out.indexOf('### #1 ✓ `Foo`');
    const barIdx = out.indexOf('### #2 ✗ `Bar.Baz`');
    expect(fooIdx).toBeGreaterThan(-1);
    expect(barIdx).toBeGreaterThan(fooIdx);
  });

  it('renders verification icons + risks', () => {
    const out = formatGraph(makeGraph(), 'markdown');
    expect(out).toContain('✓ 1 verified');
    expect(out).toContain('✗ 1 unverified');
    expect(out).toContain('`security` — auth header read');
  });

  it('renders methods + intent', () => {
    const out = formatGraph(makeGraph(), 'markdown');
    expect(out).toContain('`Run(CancellationToken)`');
    expect(out).toContain('Worker loop.');
  });

  it('renders edges grouped by source', () => {
    const out = formatGraph(makeGraph(), 'markdown');
    expect(out).toContain('## Call Graph');
    expect(out).toContain('→ `Bar.Baz`');
    expect(out).toContain('⇢ `ExternalLib` _(unverified)_');
  });
});

describe('formatGraph: Mermaid', () => {
  it('emits classDiagram header + class blocks', () => {
    const out = formatGraph(makeGraph(), 'mermaid');
    expect(out.startsWith('classDiagram')).toBe(true);
    expect(out).toContain('class Foo');
    // Dotted id must be sanitized but preserve original via label.
    expect(out).toContain('class Bar_Baz["Bar.Baz"] <<unverified>>');
  });

  it('uses dashed arrow for external_calls and solid for calls', () => {
    const out = formatGraph(makeGraph(), 'mermaid');
    expect(out).toContain('Foo --> Bar_Baz');
    // External edge target is not in the node set → must be skipped, not
    // rendered as a ghost (Mermaid would crash on the undefined symbol).
    expect(out).not.toContain('Foo ..> ExternalLib');
  });

  it('renders methods, truncating after 6', () => {
    const g = makeGraph();
    g.nodes.Foo.methods = Array.from({ length: 10 }, (_, i) => ({
      name: `M${i}`,
      signature: `M${i}()`,
      line: i,
      risks: [],
    }));
    const out = formatGraph(g, 'mermaid');
    expect(out).toContain('+M0()');
    expect(out).toContain('+M5()');
    expect(out).not.toContain('+M6()');
    expect(out).toContain('+… 4 more');
  });
});
