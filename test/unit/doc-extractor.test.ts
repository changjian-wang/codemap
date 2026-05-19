import { describe, it, expect } from 'vitest';

import { detectLang, extractDocComment, hydrateDocComments } from '../../src/orchestrator/doc-extractor';

describe('detectLang', () => {
  it('classifies common extensions', () => {
    expect(detectLang('a/b/foo.py')).toBe('py');
    expect(detectLang('Foo.cs')).toBe('csharp');
    expect(detectLang('foo.ts')).toBe('jsdoc');
    expect(detectLang('foo.tsx')).toBe('jsdoc');
    expect(detectLang('foo.java')).toBe('jsdoc');
    expect(detectLang('foo.txt')).toBe('unknown');
  });
});

describe('extractDocComment - python', () => {
  it('returns triple-quoted docstring on the line after `def`', () => {
    const src = [
      'class Foo:',
      '    def bar(self):',
      '        """Single-line doc."""',
      '        return 1',
      '',
    ].join('\n');
    // `def bar` is on line 2 (1-based).
    expect(extractDocComment({ fileText: src, startLine: 2, lang: 'py' })).toBe('Single-line doc.');
  });

  it('handles multi-line def signature before docstring', () => {
    const src = [
      'def render(',
      '    name: str,',
      '    *,',
      '    bold: bool = False,',
      ') -> str:',
      '    """Render text.',
      '',
      '    Args:',
      '        name: thing.',
      '    """',
      '    return name',
    ].join('\n');
    const doc = extractDocComment({ fileText: src, startLine: 1, lang: 'py' });
    expect(doc).toContain('Render text.');
    expect(doc).toContain('Args:');
    expect(doc?.split('\n').length).toBeGreaterThan(1);
  });
});

describe('extractDocComment - csharp', () => {
  it('strips /// and common xml tags', () => {
    const src = [
      '    /// <summary>',
      '    /// Computes the answer.',
      '    /// See <see cref="Other"/>.',
      '    /// </summary>',
      '    public int Answer() => 42;',
    ].join('\n');
    const doc = extractDocComment({ fileText: src, startLine: 5, lang: 'csharp' });
    expect(doc).toContain('Computes the answer.');
    expect(doc).not.toContain('///');
    expect(doc).not.toContain('<summary>');
    expect(doc).not.toContain('<see cref');
  });
});

describe('extractDocComment - jsdoc', () => {
  it('extracts /** ... */ above the declaration', () => {
    const src = [
      '/**',
      ' * Adds two numbers.',
      ' * @param a first',
      ' * @param b second',
      ' */',
      'export function add(a: number, b: number) { return a + b; }',
    ].join('\n');
    const doc = extractDocComment({ fileText: src, startLine: 6, lang: 'jsdoc' });
    expect(doc).toContain('Adds two numbers.');
    expect(doc).toContain('@param a');
  });

  it('falls back to contiguous // line comments', () => {
    const src = [
      '// helper used by the parser',
      '// to normalise tokens',
      'function norm(s: string) { return s.trim(); }',
    ].join('\n');
    const doc = extractDocComment({ fileText: src, startLine: 3, lang: 'jsdoc' });
    expect(doc).toBe('helper used by the parser\nto normalise tokens');
  });
});

describe('hydrateDocComments', () => {
  it('enriches both class and method docComment in place', () => {
    const fileText = [
      '// klass doc',
      'export class Widget {',
      '  /** does a thing */',
      '  run() {}',
      '}',
    ].join('\n');
    const nodes = [
      {
        range: { startLine: 2, endLine: 5 },
        methods: [{ name: 'run', line: 4 }],
      },
    ];
    hydrateDocComments(nodes, 'foo.ts', fileText);
    expect(nodes[0]).toMatchObject({ docComment: 'klass doc' });
    expect(nodes[0].methods[0]).toMatchObject({ docComment: 'does a thing' });
  });

  it('is a no-op for unknown languages', () => {
    const nodes = [{ range: { startLine: 1, endLine: 1 }, methods: [] }];
    hydrateDocComments(nodes, 'foo.unknown', 'whatever');
    expect((nodes[0] as { docComment?: string }).docComment).toBeUndefined();
  });
});
