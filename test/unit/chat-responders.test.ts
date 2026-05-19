import { describe, it, expect } from 'vitest';
import {
  explainNode,
  explainUnverified,
  focusSubgraph,
} from '../../src/chat/chat-responders';
import type { CodeMapGraph, CodeNode, CodeEdge } from '../../src/shared/types';

function node(
  id: string,
  overrides: Partial<CodeNode> = {},
): CodeNode {
  return {
    id,
    kind: 'class',
    file: `${id}.cs`,
    range: { startLine: 1, endLine: 10 },
    boundedContext: 'shared',
    intent: '',
    confidence: 0.8,
    risks: [],
    methods: [],
    readState: 'unread',
    verification: 'verified',
    ...overrides,
  };
}

function makeGraph(nodes: CodeNode[], edges: CodeEdge[] = []): CodeMapGraph {
  const nodeMap: Record<string, CodeNode> = {};
  for (const n of nodes) nodeMap[n.id] = n;
  return {
    rootRequest: '@codemap generate codemap',
    scope: 'workspace',
    nodes: nodeMap,
    edges,
    externalDeps: [],
  };
}

describe('explainNode', () => {
  it('returns a "not found" hint when target is unknown', () => {
    const g = makeGraph([node('A')]);
    const out = explainNode(g, 'NotHere');
    expect(out.found).toBe(false);
    expect(out.markdown).toContain('No class named');
  });

  it('matches case-insensitively when no direct hit', () => {
    const g = makeGraph([node('AuthController')]);
    const out = explainNode(g, 'authcontroller');
    expect(out.found).toBe(true);
    expect(out.markdown).toContain('`AuthController`');
  });

  it('reports a clean verification when no calibration drift', () => {
    const g = makeGraph([node('A', { verification: 'verified' })]);
    const out = explainNode(g, 'A');
    expect(out.markdown).toContain('Verification is **clean**');
  });

  it('surfaces droppedCalls and droppedExternalCalls for a partial node', () => {
    const g = makeGraph([
      node('A', {
        verification: 'partial',
        verificationDetails: {
          rangeAdjusted: false,
          droppedCalls: ['MysteryService'],
          droppedExternalCalls: ['Foo.Bar'],
        },
      }),
    ]);
    const out = explainNode(g, 'A');
    expect(out.markdown).toContain('`MysteryService`');
    expect(out.markdown).toContain('`Foo.Bar`');
  });

  it('flags lspNotReady so the user knows verification is provisional', () => {
    const g = makeGraph([
      node('A', {
        verification: 'verified',
        verificationDetails: {
          rangeAdjusted: false,
          droppedCalls: [],
          droppedExternalCalls: [],
          lspNotReady: true,
        },
      }),
    ]);
    const out = explainNode(g, 'A');
    expect(out.markdown).toContain('language server did not respond');
  });

  it('mentions cross-file unverified outbound edges that did not land in droppedCalls', () => {
    const g = makeGraph(
      [
        node('A', {
          verification: 'partial',
          verificationDetails: {
            rangeAdjusted: false,
            droppedCalls: [],
            droppedExternalCalls: [],
          },
        }),
        node('B'),
      ],
      [{ from: 'A', to: 'B', kind: 'calls', verified: false }],
    );
    const out = explainNode(g, 'A');
    expect(out.markdown).toContain('Cross-file calls still unverified');
    expect(out.markdown).toContain('`B`');
  });
});

describe('explainUnverified', () => {
  it('declares an all-verified graph as clean', () => {
    const g = makeGraph([node('A'), node('B')]);
    const out = explainUnverified(g);
    expect(out.count).toBe(0);
    expect(out.markdown).toContain('Every node');
  });

  it('lists partial and unverified nodes with reasons', () => {
    const g = makeGraph([
      node('Good'),
      node('PartialOne', {
        verification: 'partial',
        verificationDetails: {
          rangeAdjusted: true,
          droppedCalls: ['Missing'],
          droppedExternalCalls: [],
        },
      }),
      node('GhostOne', {
        verification: 'unverified',
        verificationDetails: {
          rangeAdjusted: false,
          droppedCalls: [],
          droppedExternalCalls: [],
          reason: 'class not found by workspace symbol provider',
        },
      }),
    ]);
    const out = explainUnverified(g);
    expect(out.count).toBe(2);
    expect(out.markdown).toMatch(/1 unverified/);
    expect(out.markdown).toMatch(/1 partial/);
    expect(out.markdown).toContain('`PartialOne`');
    expect(out.markdown).toContain('`GhostOne`');
  });

  it('truncates long lists with a "more" footer', () => {
    const nodes = Array.from({ length: 25 }).map((_, i) =>
      node(`Bad${i}`, { verification: 'unverified' }),
    );
    const g = makeGraph(nodes);
    const out = explainUnverified(g);
    expect(out.markdown).toMatch(/and 5 more/);
  });
});

describe('focusSubgraph', () => {
  it('returns a not-found result when target is missing', () => {
    const g = makeGraph([node('A')]);
    const out = focusSubgraph(g, 'NotHere');
    expect(out.found).toBe(false);
    expect(out.subgraph).toBeUndefined();
    expect(out.includedIds).toHaveLength(0);
  });

  it('keeps the target plus its ±1-hop neighbors', () => {
    const g = makeGraph(
      [node('A'), node('B'), node('C'), node('D'), node('Far')],
      [
        { from: 'A', to: 'B', kind: 'calls', verified: true },
        { from: 'C', to: 'A', kind: 'calls', verified: true },
        { from: 'D', to: 'Far', kind: 'calls', verified: true },
        { from: 'B', to: 'Far', kind: 'calls', verified: true },
      ],
    );
    const out = focusSubgraph(g, 'A');
    expect(out.found).toBe(true);
    expect(new Set(out.includedIds)).toEqual(new Set(['A', 'B', 'C']));
    // Far is excluded because it's 2 hops from A
    expect(out.subgraph!.nodes['Far']).toBeUndefined();
    // B → Far is an out-of-subgraph edge: dropped
    expect(
      out.subgraph!.edges.some(e => e.from === 'B' && e.to === 'Far'),
    ).toBe(false);
    expect(
      out.subgraph!.edges.some(e => e.from === 'A' && e.to === 'B'),
    ).toBe(true);
    expect(
      out.subgraph!.edges.some(e => e.from === 'C' && e.to === 'A'),
    ).toBe(true);
  });

  it('preserves external_calls anchored at in-subgraph nodes only', () => {
    const g: CodeMapGraph = {
      ...makeGraph(
        [node('A'), node('B'), node('Far')],
        [
          { from: 'A', to: 'B', kind: 'calls', verified: true },
          { from: 'A', to: 'ext:HttpClient', kind: 'external_calls', verified: true },
          { from: 'Far', to: 'ext:Other', kind: 'external_calls', verified: true },
        ],
      ),
      externalDeps: [
        { name: 'HttpClient', kind: 'bcl' },
        { name: 'Other', kind: 'package' },
      ],
    };
    const out = focusSubgraph(g, 'A');
    expect(
      out.subgraph!.edges.some(e => e.to === 'ext:HttpClient'),
    ).toBe(true);
    expect(out.subgraph!.edges.some(e => e.to === 'ext:Other')).toBe(false);
    // externalDeps is filtered down to what's still reachable
    expect(out.subgraph!.externalDeps.map(d => d.name)).toEqual(['HttpClient']);
  });

  it('sets a focus rootRequest and suggestedEntryNodes', () => {
    const g = makeGraph([node('Center'), node('Other')], [
      { from: 'Center', to: 'Other', kind: 'calls', verified: true },
    ]);
    const out = focusSubgraph(g, 'Center');
    expect(out.subgraph!.rootRequest).toBe('@codemap /focus Center');
    expect(out.subgraph!.scope).toBe('focus:Center');
    expect(out.subgraph!.suggestedEntryNodes).toEqual(['Center']);
    expect(out.subgraph!.readingOrder).toContain('Center');
  });
});
