import { describe, it, expect } from 'vitest';
import {
  flattenSymbolTree,
  type SymbolTreeNode,
} from '../../src/calibration/symbol-provider';

describe('flattenSymbolTree', () => {
  it('marks classes inside a namespace as top-level (C# Dev Kit wrapping)', () => {
    // C# Dev Kit returns DocumentSymbols where the namespace is the root
    // node and the actual types are its children — every C# class sits
    // at depth 1. The earlier `depth === 0` rule wrongly tagged the
    // namespace as the only top-level symbol and dropped every type from
    // the calibrator's candidate set → 100% unverified.
    const tree: SymbolTreeNode[] = [
      {
        name: 'Lumen.Modules.Recall.Endpoints',
        kind: 'Namespace',
        startLine: 1,
        endLine: 200,
        children: [
          {
            name: 'RecallEndpoints',
            kind: 'Class',
            startLine: 5,
            endLine: 180,
            children: [
              { name: 'MapRecallRoutes', kind: 'Method', startLine: 10, endLine: 30 },
            ],
          },
        ],
      },
    ];
    const out = flattenSymbolTree(tree, 'a.cs');
    expect(out.find(h => h.name === 'RecallEndpoints')?.topLevel).toBe(true);
    expect(out.find(h => h.name === 'MapRecallRoutes')?.topLevel).toBe(false);
  });

  it('marks nested types inside a class as not top-level', () => {
    // ChunkHit regression: a private record declared inside RecallQuery.cs
    // showed up in the flat symbol list and looked like a valid edge
    // target. The new rule keeps the outer class top-level and demotes
    // every nested type below it.
    const tree: SymbolTreeNode[] = [
      {
        name: 'RecallQuery',
        kind: 'Class',
        startLine: 1,
        endLine: 250,
        children: [
          { name: 'ChunkHit', kind: 'Class', startLine: 200, endLine: 220 },
          {
            name: 'Outer',
            kind: 'Class',
            startLine: 100,
            endLine: 150,
            children: [
              { name: 'Inner', kind: 'Class', startLine: 110, endLine: 140 },
            ],
          },
        ],
      },
    ];
    const out = flattenSymbolTree(tree, 'a.cs');
    expect(out.find(h => h.name === 'RecallQuery')?.topLevel).toBe(true);
    expect(out.find(h => h.name === 'ChunkHit')?.topLevel).toBe(false);
    expect(out.find(h => h.name === 'Outer')?.topLevel).toBe(false);
    expect(out.find(h => h.name === 'Inner')?.topLevel).toBe(false);
  });

  it('treats file-root types as top-level when there is no namespace wrapper', () => {
    // TS / JS / Python: types are usually declared at module scope, no
    // wrapper symbol. They must come through as topLevel=true.
    const tree: SymbolTreeNode[] = [
      { name: 'Foo', kind: 'Class', startLine: 1, endLine: 20 },
      { name: 'Bar', kind: 'Interface', startLine: 22, endLine: 30 },
      { name: 'Baz', kind: 'Enum', startLine: 32, endLine: 40 },
    ];
    const out = flattenSymbolTree(tree, 'a.ts');
    expect(out.every(h => h.topLevel === true)).toBe(true);
  });

  it('keeps types nested inside structs / interfaces / enums non-top-level', () => {
    const tree: SymbolTreeNode[] = [
      {
        name: 'OuterStruct',
        kind: 'Struct',
        startLine: 1,
        endLine: 50,
        children: [{ name: 'NestedInStruct', kind: 'Class', startLine: 10, endLine: 20 }],
      },
      {
        name: 'OuterInterface',
        kind: 'Interface',
        startLine: 60,
        endLine: 100,
        children: [{ name: 'NestedInInterface', kind: 'Class', startLine: 70, endLine: 80 }],
      },
    ];
    const out = flattenSymbolTree(tree, 'a.cs');
    expect(out.find(h => h.name === 'OuterStruct')?.topLevel).toBe(true);
    expect(out.find(h => h.name === 'OuterInterface')?.topLevel).toBe(true);
    expect(out.find(h => h.name === 'NestedInStruct')?.topLevel).toBe(false);
    expect(out.find(h => h.name === 'NestedInInterface')?.topLevel).toBe(false);
  });

  it('handles nested namespaces (e.g. C# `namespace A.B { namespace C { ... } }`)', () => {
    const tree: SymbolTreeNode[] = [
      {
        name: 'A.B',
        kind: 'Namespace',
        startLine: 1,
        endLine: 100,
        children: [
          {
            name: 'C',
            kind: 'Namespace',
            startLine: 5,
            endLine: 95,
            children: [{ name: 'Deep', kind: 'Class', startLine: 10, endLine: 80 }],
          },
        ],
      },
    ];
    const out = flattenSymbolTree(tree, 'a.cs');
    expect(out.find(h => h.name === 'Deep')?.topLevel).toBe(true);
  });

  it('propagates 1-based line numbers and the kind string verbatim', () => {
    const tree: SymbolTreeNode[] = [
      { name: 'Foo', kind: 'Class', startLine: 5, endLine: 50 },
    ];
    const out = flattenSymbolTree(tree, 'src/foo.ts');
    expect(out[0]).toEqual({
      name: 'Foo',
      file: 'src/foo.ts',
      startLine: 5,
      endLine: 50,
      kind: 'Class',
      topLevel: true,
    });
  });

  it('returns empty for an empty roots array', () => {
    expect(flattenSymbolTree([], 'a.ts')).toEqual([]);
  });
});
