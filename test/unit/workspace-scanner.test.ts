import { describe, it, expect } from 'vitest';
import {
  scanWorkspace,
  isEntryPoint,
  extractImports,
  type FileReader,
} from '../../src/orchestrator/workspace-scanner';

/** In-memory FileReader for tests. Filenames use POSIX separators. */
function makeReader(fs: Record<string, string>): FileReader {
  return {
    async listFiles() {
      return Object.keys(fs);
    },
    async readText(rel) {
      return Object.prototype.hasOwnProperty.call(fs, rel) ? fs[rel] : undefined;
    },
    async resolveImport(fromRel, target) {
      if (!target.startsWith('.')) return undefined;
      const fromDir = fromRel.split('/').slice(0, -1).join('/');
      const joined = normalize(`${fromDir}/${target}`);
      const candidates = [
        joined,
        `${joined}.ts`,
        `${joined}.tsx`,
        `${joined}/index.ts`,
      ];
      for (const c of candidates) {
        if (Object.prototype.hasOwnProperty.call(fs, c)) return c;
      }
      return undefined;
    },
  };
}
function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

describe('isEntryPoint', () => {
  it.each([
    ['apps/api/src/Lumen.Host/Program.cs', true],
    ['apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs', true],
    ['src/main.ts', true],
    ['src/app.tsx', true],
    ['src/foo/index.ts', true],
    ['apps/api/src/Lumen.Modules.Capture/Persistence/EventStore.cs', false],
    ['src/utils/helpers.ts', false],
  ])('%s → %s', (file, expected) => {
    expect(isEntryPoint(file)).toBe(expected);
  });
});

describe('extractImports', () => {
  it('parses C# using statements', () => {
    const src = `using System;
using System.Text.Json;
using Lumen.Modules.Capture.Persistence;
namespace X { class Y {} }`;
    expect(extractImports(src, '.cs')).toEqual([
      'System',
      'System.Text.Json',
      'Lumen.Modules.Capture.Persistence',
    ]);
  });

  it('parses TS import / require', () => {
    const src = `
      import foo from './foo';
      import { bar } from './bar';
      import * as baz from './baz';
      const qux = require('./qux');
    `;
    expect(extractImports(src, '.ts')).toEqual(['./foo', './bar', './baz', './qux']);
  });

  it('returns [] for unknown extensions', () => {
    expect(extractImports('whatever', '.md')).toEqual([]);
  });
});

describe('scanWorkspace', () => {
  it('returns [] when no entry points exist', async () => {
    const reader = makeReader({ 'src/util.ts': 'export const x = 1;' });
    const r = await scanWorkspace(reader);
    expect(r.entryPoints).toEqual([]);
    expect(r.skeleton).toEqual([]);
  });

  it('seeds from entry point and BFS into relative imports', async () => {
    const reader = makeReader({
      'src/main.ts': `import { a } from './a'; import { b } from './b';`,
      'src/a.ts': `import { c } from './c';`,
      'src/b.ts': `export const b = 1;`,
      'src/c.ts': `export const c = 2;`,
      'src/unrelated.ts': `export const z = 0;`,
    });
    const r = await scanWorkspace(reader);
    expect(r.entryPoints).toEqual(['src/main.ts']);
    // BFS order: main → a, b → c
    expect(r.skeleton).toEqual(['src/main.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(r.overflow).toContain('src/unrelated.ts');
  });

  it('honours maxFiles', async () => {
    const fs: Record<string, string> = { 'src/main.ts': '' };
    for (let i = 0; i < 50; i++) {
      fs['src/main.ts'] += `import './f${i}';`;
      fs[`src/f${i}.ts`] = '';
    }
    const reader = makeReader(fs);
    const r = await scanWorkspace(reader, { maxDepth: 3, maxFiles: 10, extensions: ['.ts'] });
    expect(r.skeleton.length).toBe(10);
  });

  it('honours maxDepth (no expansion past the limit)', async () => {
    const reader = makeReader({
      'src/main.ts': `import './a';`,
      'src/a.ts': `import './b';`,
      'src/b.ts': `import './c';`,
      'src/c.ts': '',
    });
    const r = await scanWorkspace(reader, { maxDepth: 1, maxFiles: 30, extensions: ['.ts'] });
    // main (depth 0) reads imports → a (depth 1). a is enqueued at depth 1
    // and is added to skeleton; but its imports (depth 2) are not expanded
    // because depth >= maxDepth at that point.
    expect(r.skeleton).toEqual(['src/main.ts', 'src/a.ts']);
  });

  it('orders entries by pattern priority (Program.cs before *Endpoints.cs before index.ts)', async () => {
    const reader = makeReader({
      'apps/api/src/Lumen.Host/Program.cs': '',
      'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs': '',
      'apps/web/src/index.ts': '',
    });
    const r = await scanWorkspace(reader);
    expect(r.entryPoints[0]).toBe('apps/api/src/Lumen.Host/Program.cs');
    expect(r.entryPoints[1]).toBe(
      'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs',
    );
    expect(r.entryPoints[2]).toBe('apps/web/src/index.ts');
  });

  it('does not enqueue files that fall outside the eligible extension set', async () => {
    const reader = makeReader({
      'src/main.ts': `import './style.css';`,
      'src/style.css': '/* */',
    });
    const r = await scanWorkspace(reader);
    expect(r.skeleton).toEqual(['src/main.ts']);
  });
});
