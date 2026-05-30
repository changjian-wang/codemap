// Phase 3.3b -- pure responders.ts coverage. No vscode imports.

import { describe, it, expect } from 'vitest';
import {
  explainClass,
  explainUnverified,
  focusSubgraph,
  formatVerificationDigest,
  listEntries,
} from '../../../src/chat/responders';
import type {
  ClassNode,
  CodeMapGraph,
  MethodEdge,
  MethodNode,
} from '../../../src/shared/types';

function cls(overrides: Partial<ClassNode> & { id: string; file: string; methodIds: string[] }): ClassNode {
  return {
    kind: 'class',
    boundedContext: 'core',
    range: { startLine: 1, endLine: 10 },
    intent: 'test',
    confidence: 0.9,
    risks: [],
    verification: 'verified',
    ...overrides,
  };
}

function mth(overrides: Partial<MethodNode> & { id: string; ownerClassId: string; name: string }): MethodNode {
  return {
    signature: '()',
    line: 5,
    risks: [],
    verification: 'verified',
    ...overrides,
  };
}

function graph(overrides: Partial<CodeMapGraph> = {}): CodeMapGraph {
  return {
    schemaVersion: 2,
    rootRequest: '@codemap generate codemap',
    scope: 'workspace',
    boundedContexts: ['core'],
    classes: {},
    methods: {},
    externalDeps: {},
    methodEdges: [],
    classEdges: [],
    entryMethodIds: [],
    readingOrder: [],
    ...overrides,
  };
}

// =========================================================================
//   explainClass
// =========================================================================

describe('explainClass', () => {
  it('returns a not-found marker when the class is absent', () => {
    const g = graph();
    const r = explainClass(g, 'Nope');
    expect(r.found).toBe(false);
    expect(r.markdown).toContain('No class named `Nope`');
  });

  it('is fuzzy on case', () => {
    const g = graph({ classes: { Capture: cls({ id: 'Capture', file: 'a.cs', methodIds: [] }) } });
    const r = explainClass(g, 'capture');
    expect(r.found).toBe(true);
    expect(r.markdown).toContain('### `Capture`');
  });

  it('reports a clean verification when there are no details', () => {
    const g = graph({
      classes: {
        A: cls({ id: 'A', file: 'a.cs', methodIds: [], verification: 'verified' }),
      },
    });
    const r = explainClass(g, 'A');
    expect(r.markdown).toContain('OK verified');
    expect(r.markdown).toContain('Verification is **clean**');
  });

  it('surfaces lspNotReady, rangeAdjusted, droppedTargets', () => {
    const g = graph({
      classes: {
        A: cls({
          id: 'A',
          file: 'a.cs',
          methodIds: [],
          verification: 'partial',
          verificationDetails: {
            rangeAdjusted: true,
            droppedTargets: ['Foo', 'Bar'],
            lspNotReady: true,
            reason: 'tsconfig missing',
          },
        }),
      },
    });
    const r = explainClass(g, 'A');
    expect(r.markdown).toContain('provisional');
    expect(r.markdown).toContain('Range adjusted');
    expect(r.markdown).toContain('`Foo`');
    expect(r.markdown).toContain('`Bar`');
    expect(r.markdown).toContain('> tsconfig missing');
  });

  it('lists unverified outbound class edges not already in droppedTargets', () => {
    const g = graph({
      classes: {
        A: cls({
          id: 'A',
          file: 'a.cs',
          methodIds: [],
          verification: 'partial',
          verificationDetails: { rangeAdjusted: false, droppedTargets: ['Foo'] },
        }),
      },
      classEdges: [
        { source: 'A', target: 'Foo', kind: 'calls', multiplicity: 1, verified: false },
        { source: 'A', target: 'Bar', kind: 'calls', multiplicity: 1, verified: false },
        { source: 'A', target: 'Baz', kind: 'calls', multiplicity: 1, verified: true },
      ],
    });
    const r = explainClass(g, 'A');
    expect(r.markdown).toContain('Bar');
    expect(r.markdown).not.toContain('Cross-file calls still unverified after aggregation:** `Foo`');
    expect(r.markdown).not.toContain('Baz');
  });
});

// =========================================================================
//   explainUnverified
// =========================================================================

describe('explainUnverified', () => {
  it('returns OK message when nothing to explain', () => {
    const g = graph({ classes: { A: cls({ id: 'A', file: 'a.cs', methodIds: [] }) } });
    const r = explainUnverified(g);
    expect(r.count).toBe(0);
    expect(r.markdown).toContain('verified');
  });

  it('lists partial and unverified separately and respects the 20-cap', () => {
    const classes: Record<string, ClassNode> = {};
    for (let i = 0; i < 25; i++) {
      classes[`U${i}`] = cls({ id: `U${i}`, file: `u${i}.cs`, methodIds: [], verification: 'unverified' });
    }
    for (let i = 0; i < 22; i++) {
      classes[`P${i}`] = cls({ id: `P${i}`, file: `p${i}.cs`, methodIds: [], verification: 'partial' });
    }
    const r = explainUnverified(graph({ classes }));
    expect(r.count).toBe(47);
    expect(r.markdown).toContain('### Unverified');
    expect(r.markdown).toContain('### Partial');
    expect(r.markdown).toContain('...and 5 more');
    expect(r.markdown).toContain('...and 2 more');
  });
});

// =========================================================================
//   focusSubgraph
// =========================================================================

describe('focusSubgraph', () => {
  function buildGraph(): CodeMapGraph {
    const classes: Record<string, ClassNode> = {
      A: cls({ id: 'A', file: 'a.cs', methodIds: ['A.Do'], boundedContext: 'capture' }),
      B: cls({ id: 'B', file: 'b.cs', methodIds: ['B.Run'], boundedContext: 'recall' }),
      C: cls({ id: 'C', file: 'c.cs', methodIds: ['C.Other'], boundedContext: 'shared' }),
      Z: cls({ id: 'Z', file: 'z.cs', methodIds: [], boundedContext: 'misc' }),
    };
    const methods: Record<string, MethodNode> = {
      'A.Do': mth({ id: 'A.Do', ownerClassId: 'A', name: 'Do' }),
      'B.Run': mth({ id: 'B.Run', ownerClassId: 'B', name: 'Run' }),
      'C.Other': mth({ id: 'C.Other', ownerClassId: 'C', name: 'Other' }),
    };
    const methodEdges: MethodEdge[] = [
      { id: 'e0', source: 'A.Do', target: 'B.Run', kind: 'calls', verified: true },
      { id: 'e1', source: 'B.Run', target: 'C.Other', kind: 'calls', verified: true },
      { id: 'e2', source: 'A.Do', target: 'ext:OpenAI', kind: 'external_calls', verified: true },
    ];
    return graph({
      classes,
      methods,
      methodEdges,
      classEdges: [
        { source: 'A', target: 'B', kind: 'calls', multiplicity: 1, verified: true },
        { source: 'B', target: 'C', kind: 'calls', multiplicity: 1, verified: true },
        { source: 'A', target: 'ext:OpenAI', kind: 'external_calls', multiplicity: 1, verified: true },
      ],
      externalDeps: { 'ext:OpenAI': { id: 'ext:OpenAI', name: 'OpenAI', kind: 'package' } },
      entryMethodIds: ['A.Do'],
    });
  }

  it('returns not-found markdown when target missing', () => {
    const r = focusSubgraph(buildGraph(), 'Missing');
    expect(r.found).toBe(false);
    expect(r.subgraph).toBeUndefined();
    expect(r.markdown).toContain('No class named `Missing`');
  });

  it('keeps target + 1-hop in/out neighbors, drops the rest', () => {
    const r = focusSubgraph(buildGraph(), 'B');
    expect(r.found).toBe(true);
    expect(r.includedClassIds.sort()).toEqual(['A', 'B', 'C']);
    expect(r.subgraph).toBeDefined();
    expect(Object.keys(r.subgraph!.classes).sort()).toEqual(['A', 'B', 'C']);
    expect(r.subgraph!.classes.Z).toBeUndefined();
  });

  it('preserves method edges between included classes and external edges', () => {
    const r = focusSubgraph(buildGraph(), 'A');
    expect(r.includedClassIds.sort()).toEqual(['A', 'B']);
    const targets = r.subgraph!.methodEdges.map((e) => e.target).sort();
    expect(targets).toEqual(['B.Run', 'ext:OpenAI']);
    expect(r.subgraph!.externalDeps['ext:OpenAI']).toBeDefined();
    expect(r.subgraph!.classEdges.length).toBeGreaterThan(0);
  });

  it('filters entryMethodIds to in-subgraph methods', () => {
    const r = focusSubgraph(buildGraph(), 'C');
    expect(r.subgraph!.entryMethodIds).toEqual([]);
  });

  it('orders boundedContexts with shared last', () => {
    const r = focusSubgraph(buildGraph(), 'B');
    expect(r.subgraph!.boundedContexts).toEqual(['capture', 'recall', 'shared']);
  });
});

// =========================================================================
//   formatVerificationDigest
// =========================================================================

describe('formatVerificationDigest', () => {
  it('returns undefined when everything is verified', () => {
    const g = graph({ classes: { A: cls({ id: 'A', file: 'a.cs', methodIds: [] }) } });
    expect(formatVerificationDigest(g)).toBeUndefined();
  });

  it('caps to maxItems with a truncation hint per bucket', () => {
    const classes: Record<string, ClassNode> = {};
    for (let i = 0; i < 12; i++) {
      classes[`P${i}`] = cls({ id: `P${i}`, file: `p${i}.cs`, methodIds: [], verification: 'partial' });
    }
    for (let i = 0; i < 11; i++) {
      classes[`U${i}`] = cls({ id: `U${i}`, file: `u${i}.cs`, methodIds: [], verification: 'unverified' });
    }
    const md = formatVerificationDigest(graph({ classes }), 5)!;
    expect(md).toContain('Why 12 partial / 11 unverified?');
    expect(md).toContain('...and 7 more partial');
    expect(md).toContain('...and 6 more unverified');
  });
});

// =========================================================================
//   listEntries
// =========================================================================

describe('listEntries', () => {
  it('reports zero when no classes are tagged isEntry', () => {
    const g = graph({ classes: { A: cls({ id: 'A', file: 'a.cs', methodIds: [] }) } });
    const r = listEntries(g);
    expect(r.count).toBe(0);
    expect(r.markdown).toContain('No entry-point classes tagged');
  });

  it('groups by entryKind in canonical order with unknown bucket last', () => {
    const classes: Record<string, ClassNode> = {
      H1: cls({
        id: 'H1',
        file: 'h1.cs',
        methodIds: [],
        isEntry: true,
        entryKind: 'http_endpoint',
        entryMeta: { routes: ['GET /a'] },
      }),
      W1: cls({
        id: 'W1',
        file: 'w1.cs',
        methodIds: [],
        isEntry: true,
        entryKind: 'worker',
      }),
      X1: cls({ id: 'X1', file: 'x1.cs', methodIds: [], isEntry: true }),
    };
    const r = listEntries(graph({ classes }));
    expect(r.count).toBe(3);
    const httpIdx = r.markdown.indexOf('### HTTP endpoints');
    const workerIdx = r.markdown.indexOf('### Workers');
    const unknownIdx = r.markdown.indexOf('### Tagged');
    expect(httpIdx).toBeGreaterThanOrEqual(0);
    expect(workerIdx).toBeGreaterThan(httpIdx);
    expect(unknownIdx).toBeGreaterThan(workerIdx);
    expect(r.markdown).toContain('`GET /a`');
  });

  it('truncates publicApis at 4 with a `(+N more)` tail', () => {
    const classes: Record<string, ClassNode> = {
      A1: cls({
        id: 'A1',
        file: 'a1.cs',
        methodIds: [],
        isEntry: true,
        entryKind: 'public_api',
        entryMeta: { publicApis: ['a', 'b', 'c', 'd', 'e', 'f'] },
      }),
    };
    const r = listEntries(graph({ classes }));
    expect(r.markdown).toContain('apis: `a`, `b`, `c`, `d`');
    expect(r.markdown).toContain('_(+2 more)_');
  });
});
