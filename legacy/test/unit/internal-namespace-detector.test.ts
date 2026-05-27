import { describe, it, expect } from 'vitest';
import {
  detectInternalNamespaces,
  extractCSharpNamespaceRoots,
  extractTypeScriptPackageNames,
} from '../../src/orchestrator/internal-namespace-detector';

describe('extractCSharpNamespaceRoots', () => {
  it('matches file-scoped namespace', () => {
    const src = `namespace Lumen.Modules.Capture;\n\npublic class Foo {}`;
    expect(extractCSharpNamespaceRoots(src)).toEqual(['Lumen']);
  });

  it('matches block-scoped namespace', () => {
    const src = `namespace Lumen.Host {\n  public class Bar {}\n}`;
    expect(extractCSharpNamespaceRoots(src)).toEqual(['Lumen']);
  });

  it('captures multiple distinct roots when a file declares more than one', () => {
    const src = `namespace Alpha.A;\nnamespace Beta.B { }`;
    expect(extractCSharpNamespaceRoots(src).sort()).toEqual(['Alpha', 'Beta']);
  });

  it('deduplicates repeated roots from multiple declarations', () => {
    const src = `namespace Lumen.A;\nnamespace Lumen.B { }`;
    expect(extractCSharpNamespaceRoots(src)).toEqual(['Lumen']);
  });

  it('supports a single-segment namespace (no dots)', () => {
    const src = `namespace Root;\npublic class X {}`;
    expect(extractCSharpNamespaceRoots(src)).toEqual(['Root']);
  });

  it('ignores `using` directives, comments, and strings', () => {
    const src = `// namespace FakeFromComment;\nusing System;\nvar s = "namespace AlsoFake;";\nnamespace Real.Code;`;
    expect(extractCSharpNamespaceRoots(src)).toEqual(['Real']);
  });

  it('returns [] for files with no namespace declaration (top-level statements)', () => {
    const src = `using System;\n\nvar app = WebApplication.CreateBuilder(args).Build();\napp.Run();`;
    expect(extractCSharpNamespaceRoots(src)).toEqual([]);
  });

  it('handles indented namespace declarations', () => {
    const src = `\n    namespace Foo.Bar;\n`;
    expect(extractCSharpNamespaceRoots(src)).toEqual(['Foo']);
  });
});

describe('extractTypeScriptPackageNames', () => {
  it('returns the bare name for an unscoped package', () => {
    const pkg = JSON.stringify({ name: 'codemap', version: '0.0.5' });
    expect(extractTypeScriptPackageNames(pkg)).toEqual(['codemap']);
  });

  it('returns both scope and leaf for a scoped package', () => {
    const pkg = JSON.stringify({ name: '@codemap/core', version: '1.0.0' });
    expect(extractTypeScriptPackageNames(pkg).sort()).toEqual(['codemap', 'core']);
  });

  it('returns [] for malformed JSON', () => {
    expect(extractTypeScriptPackageNames('{ not json')).toEqual([]);
  });

  it('returns [] for missing `name` field', () => {
    expect(extractTypeScriptPackageNames('{}')).toEqual([]);
  });

  it('returns [] for empty string name', () => {
    expect(extractTypeScriptPackageNames(JSON.stringify({ name: '' }))).toEqual([]);
  });

  it('returns [] for non-string name (e.g. accidental array)', () => {
    expect(extractTypeScriptPackageNames(JSON.stringify({ name: ['a', 'b'] }))).toEqual([]);
  });

  it('returns [] for a top-level array (not an object)', () => {
    expect(extractTypeScriptPackageNames('[]')).toEqual([]);
  });
});

describe('detectInternalNamespaces (orchestrator-facing)', () => {
  it('combines C# roots from .cs files with TS root from package.json', () => {
    const filesWithText = new Map([
      ['apps/api/src/Lumen.Host/Program.cs', 'namespace Lumen.Host;\nclass Program {}'],
      [
        'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs',
        'namespace Lumen.Modules.Capture.Endpoints;\nclass CaptureEndpoints {}',
      ],
    ]);
    const out = detectInternalNamespaces({
      filesWithText,
      packageJsonText: JSON.stringify({ name: '@codemap/core' }),
    });
    // Sorted, deduplicated.
    expect(out).toEqual(['Lumen', 'codemap', 'core']);
  });

  it('only inspects .cs files for C# namespace detection', () => {
    const filesWithText = new Map([
      // A TypeScript file containing a `namespace` keyword — should NOT
      // contribute (TS namespaces are syntactically allowed but irrelevant
      // here; we'd need a separate TS-aware extractor).
      ['src/Foo.ts', 'namespace IgnoreMe { export class Foo {} }'],
      // A real .cs file does.
      ['src/Bar.cs', 'namespace Real;\nclass Bar {}'],
    ]);
    expect(detectInternalNamespaces({ filesWithText })).toEqual(['Real']);
  });

  it('returns [] when neither C# files nor package.json yield anything', () => {
    const filesWithText = new Map([
      ['src/Top.cs', 'using System;\nvar x = 1;'], // no namespace decl
    ]);
    expect(detectInternalNamespaces({ filesWithText })).toEqual([]);
  });

  it('output is sorted and deduplicated across both sources', () => {
    const filesWithText = new Map([
      ['a.cs', 'namespace Zeta;\nclass A {}'],
      ['b.cs', 'namespace Alpha.X;\nclass B {}'],
      ['c.cs', 'namespace Alpha.Y;\nclass C {}'], // duplicate root "Alpha"
    ]);
    const out = detectInternalNamespaces({
      filesWithText,
      packageJsonText: JSON.stringify({ name: 'beta-pkg' }),
    });
    expect(out).toEqual(['Alpha', 'Zeta', 'beta-pkg']);
  });

  it('is case-sensitive — different cases are different roots', () => {
    const filesWithText = new Map([
      ['a.cs', 'namespace lumen;\nclass A {}'],
      ['b.cs', 'namespace Lumen;\nclass B {}'],
    ]);
    expect(detectInternalNamespaces({ filesWithText })).toEqual(['Lumen', 'lumen']);
  });

  it('handles missing package.json (undefined) without crashing', () => {
    const filesWithText = new Map([['x.cs', 'namespace OnlyCs;\nclass X {}']]);
    expect(detectInternalNamespaces({ filesWithText, packageJsonText: undefined })).toEqual([
      'OnlyCs',
    ]);
  });

  it('treats file extension case-insensitively (.CS as well as .cs)', () => {
    const filesWithText = new Map([['Mixed.CS', 'namespace UpperExt;\nclass M {}']]);
    expect(detectInternalNamespaces({ filesWithText })).toEqual(['UpperExt']);
  });
});
