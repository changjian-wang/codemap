import { describe, it, expect } from 'vitest';
import * as YAML from 'yaml';
import type { CodeMapGraph } from '../../src/shared/types';
import type { MockupData } from '../../src/webview/graph-adapter';
import { formatYaml, formatStandaloneHtml } from '../../src/export/formatters';

function makeGraph(overrides: Partial<CodeMapGraph> = {}): CodeMapGraph {
  return {
    rootRequest: '@codemap generate codemap',
    scope: 'apps/api/src',
    rootIntent: 'Test intent.',
    nodes: {
      Foo: {
        id: 'Foo',
        kind: 'class',
        file: 'src/Foo.cs',
        range: { startLine: 10, endLine: 50 },
        boundedContext: 'capture',
        intent: 'Captures events.\nSecond line.',
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
    },
    edges: [],
    externalDeps: [],
    ...overrides,
  };
}

function makeMockupData(): MockupData {
  return {
    classes: [],
    externalDeps: [],
    edges: [],
    chatTurns: [],
    meta: {
      repoName: 'lumen',
      scope: 'apps/api/src',
      bcLabels: { host: 'Host', capture: 'Capture', recall: 'Recall', shared: 'Shared' },
    },
  };
}

describe('formatYaml', () => {
  it('round-trips through YAML.parse with structural fidelity', () => {
    const g = makeGraph();
    const out = formatYaml(g);
    const parsed = YAML.parse(out) as CodeMapGraph;
    expect(parsed.scope).toBe('apps/api/src');
    expect(parsed.nodes.Foo.id).toBe('Foo');
    expect(parsed.nodes.Foo.methods.length).toBe(1);
    expect(parsed.edges).toEqual([]);
  });

  it('preserves multi-line strings (intent / risks descriptions)', () => {
    const out = formatYaml(makeGraph());
    const parsed = YAML.parse(out) as CodeMapGraph;
    expect(parsed.nodes.Foo.intent).toBe('Captures events.\nSecond line.');
  });

  it('does not auto-wrap long single-line content (lineWidth: 0)', () => {
    const g = makeGraph();
    g.nodes.Foo.intent =
      'A single long line that under default YAML output would get hard-wrapped at column 80 making downstream tooling unhappy when comparing snapshots.';
    const out = formatYaml(g);
    expect(out).toContain(g.nodes.Foo.intent);
  });
});

describe('formatStandaloneHtml', () => {
  const TEMPLATE =
    '<!doctype html><html><head><title>placeholder</title></head><body><div id="root"></div></body></html>';

  it('injects __CODEMAP_DATA__ before </head> and sets the title', () => {
    const out = formatStandaloneHtml(TEMPLATE, makeMockupData());
    expect(out).toContain('window.__CODEMAP_DATA__');
    expect(out).toContain('CodeMap — lumen · apps/api/src');
    // Bootstrap must precede the closing </head>, never be appended raw.
    const dataIdx = out.indexOf('__CODEMAP_DATA__');
    const headCloseIdx = out.indexOf('</head>');
    expect(dataIdx).toBeGreaterThan(-1);
    expect(headCloseIdx).toBeGreaterThan(dataIdx);
  });

  it('escapes "<" in the JSON payload so the page never closes the script tag', () => {
    const data = makeMockupData();
    (data as MockupData).chatTurns = [
      { role: 'user', name: 'You', time: '10:00', content: '</script>oops' },
    ];
    const out = formatStandaloneHtml(TEMPLATE, data);
    expect(out).not.toMatch(/<\/script>oops/);
    expect(out).toContain('\\u003c/script>oops');
  });

  it('handles a template without <head> by prepending the bootstrap', () => {
    const out = formatStandaloneHtml('<html><body></body></html>', makeMockupData());
    expect(out.startsWith('\n    <script>')).toBe(true);
    expect(out).toContain('window.__CODEMAP_DATA__');
  });

  it('sets STANDALONE flag and bc relabel script', () => {
    const out = formatStandaloneHtml(TEMPLATE, makeMockupData());
    expect(out).toContain('window.__CODEMAP_STANDALONE__ = true');
    expect(out).toContain("classList.add('codemap-standalone')");
  });

  it('hides vscode-only controls via CSS', () => {
    const out = formatStandaloneHtml(TEMPLATE, makeMockupData());
    expect(out).toContain('#analyzeBtn');
    expect(out).toContain('#resetBtn');
    expect(out).toContain('#exportBtn');
    expect(out).toContain('display: none !important');
  });
});
