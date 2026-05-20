import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { graphToGolden, stringifyGolden } from '../../src/eval/golden-writer';
import type { CodeMapGraph, CodeNode } from '../../src/shared/types';

function makeNode(id: string, file: string, extra: Partial<CodeNode> = {}): CodeNode {
  return {
    id,
    kind: 'class',
    boundedContext: 'shared',
    file,
    range: { startLine: 1, endLine: 10 },
    methods: [],
    intent: '',
    risks: [],
    verification: 'verified',
    confidence: 1,
    readingPriority: 1,
    readState: 'unread',
    ...extra,
  };
}

describe('graphToGolden', () => {
  it('produces stable sorted node + edge lists', () => {
    const graph: CodeMapGraph = {
      rootRequest: '',
      scope: 'workspace',
      nodes: {
        Bravo: makeNode('Bravo', 'src/b.ts'),
        Alpha: makeNode('Alpha', 'src/a.ts'),
      },
      edges: [
        { from: 'Bravo', to: 'Alpha', kind: 'calls', verified: true },
        { from: 'Alpha', to: 'Bravo', kind: 'calls', verified: true },
      ],
      externalDeps: [],
    };
    const g = graphToGolden(graph, { name: 'demo' });
    expect(g.nodes).toEqual(['Alpha', 'Bravo']); // sorted
    expect(g.edges).toEqual([
      { from: 'Alpha', to: 'Bravo' },
      { from: 'Bravo', to: 'Alpha' },
    ]);
  });

  it('honours scopeFiles to filter nodes', () => {
    const graph: CodeMapGraph = {
      rootRequest: '',
      scope: 'workspace',
      nodes: {
        InScope: makeNode('InScope', 'src/in/X.ts'),
        OutScope: makeNode('OutScope', 'lib/Y.ts'),
      },
      edges: [],
      externalDeps: [],
    };
    const g = graphToGolden(graph, { name: 'demo', scopeFiles: ['src/in'] });
    expect(g.nodes).toEqual(['InScope']);
    expect(g.scopeFiles).toEqual(['src/in']);
  });

  it('preserves external_calls edges with explicit kind', () => {
    const graph: CodeMapGraph = {
      rootRequest: '',
      scope: 'workspace',
      nodes: { A: makeNode('A', 'src/A.ts') },
      edges: [
        { from: 'A', to: 'ext:Foo', kind: 'external_calls', verified: false },
        { from: 'A', to: 'A', kind: 'contains', verified: true }, // skipped
      ],
      externalDeps: [],
    };
    const g = graphToGolden(graph, { name: 'demo' });
    expect(g.edges).toEqual([{ from: 'A', to: 'ext:Foo', kind: 'external_calls' }]);
  });

  it('drops edges whose `from` falls outside scope', () => {
    const graph: CodeMapGraph = {
      rootRequest: '',
      scope: 'workspace',
      nodes: {
        In: makeNode('In', 'src/In.ts'),
        Out: makeNode('Out', 'lib/Out.ts'),
      },
      edges: [
        { from: 'Out', to: 'In', kind: 'calls', verified: true }, // dropped — from out of scope
        { from: 'In', to: 'Out', kind: 'calls', verified: true }, // kept
      ],
      externalDeps: [],
    };
    const g = graphToGolden(graph, { name: 'demo', scopeFiles: ['src/'] });
    expect(g.edges).toEqual([{ from: 'In', to: 'Out' }]);
  });

  it('deduplicates duplicate edges', () => {
    const graph: CodeMapGraph = {
      rootRequest: '',
      scope: 'workspace',
      nodes: { A: makeNode('A', 'a.ts'), B: makeNode('B', 'b.ts') },
      edges: [
        { from: 'A', to: 'B', kind: 'calls', verified: true },
        { from: 'A', to: 'B', kind: 'calls', verified: false },
      ],
      externalDeps: [],
    };
    const g = graphToGolden(graph, { name: 'demo' });
    expect(g.edges).toHaveLength(1);
  });
});

describe('stringifyGolden', () => {
  it('emits stable key order: name → description → scopeFiles → nodes → edges', () => {
    const text = stringifyGolden({
      name: 'demo',
      description: 'A demo',
      scopeFiles: ['src'],
      nodes: ['B', 'A'],
      edges: [{ from: 'A', to: 'B' }],
    });
    const keys = Array.from(text.matchAll(/^  "([^"]+)":/gm)).map(m => m[1]);
    expect(keys).toEqual(['name', 'description', 'scopeFiles', 'nodes', 'edges']);
  });

  it('omits optional keys cleanly when not present', () => {
    const text = stringifyGolden({
      name: 'minimal',
      nodes: ['A'],
      edges: [],
    });
    expect(text).not.toMatch(/description/);
    expect(text).not.toMatch(/scopeFiles/);
    expect(text.endsWith('\n')).toBe(true);
  });
});
