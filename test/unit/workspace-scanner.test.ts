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

  it('fillToMaxFiles tops up skeleton when BFS cannot resolve imports (C# scenario)', async () => {
    // Mimic lumen/apps/api/src: 5 entry points + many .cs files where every
    // `using` statement is a namespace, not a path, so resolveImport always
    // returns undefined. BFS from entries discovers nothing more; without
    // fillToMaxFiles the skeleton would be just the 5 entries.
    const fs: Record<string, string> = {
      'apps/api/src/Lumen.Host/Program.cs': 'using System;',
      'apps/api/src/Lumen.Eval/Program.cs': 'using System;',
      'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs': 'using System;',
      'apps/api/src/Lumen.Modules.Recall/Endpoints/RecallEndpoints.cs': 'using System;',
      'apps/api/src/Lumen.Modules.Connect/Endpoints/ConnectEndpoints.cs': 'using System;',
    };
    // 168 additional non-entry .cs files spread across module subdirs.
    for (let i = 0; i < 168; i++) {
      fs[`apps/api/src/Lumen.Modules.Capture/Features/Handler${i}.cs`] = 'using System;';
    }
    const reader: FileReader = {
      async listFiles() { return Object.keys(fs); },
      async readText(rel) { return fs[rel]; },
      async resolveImport() { return undefined; }, // C# `using` never resolves to a file
    };
    const r = await scanWorkspace(reader, {
      maxDepth: 3,
      maxFiles: 80,
      extensions: ['.cs'],
      rankBy: 'centrality',
      fillToMaxFiles: true,
    });
    expect(r.entryPoints.length).toBe(5);
    expect(r.skeleton.length).toBe(80); // <- the bug: was 5 without fill
    // Entries survive at the front; the rest is filled with shortest-path-first
    // remainder of eligible files.
    for (const e of r.entryPoints) expect(r.skeleton).toContain(e);
    expect(r.overflow.length).toBe(173 - 80);
  });

  it('fillToMaxFiles is a no-op when BFS already filled the skeleton', async () => {
    // TS scenario where every relative import resolves: fill should not
    // double-add already-included files.
    const fs: Record<string, string> = { 'src/main.ts': '' };
    for (let i = 0; i < 50; i++) {
      fs['src/main.ts'] += `import './f${i}';`;
      fs[`src/f${i}.ts`] = '';
    }
    const reader = makeReader(fs);
    const r = await scanWorkspace(reader, {
      maxDepth: 3,
      maxFiles: 10,
      extensions: ['.ts'],
      rankBy: 'centrality',
      fillToMaxFiles: true,
    });
    expect(r.skeleton.length).toBe(10);
    // No duplicates.
    expect(new Set(r.skeleton).size).toBe(10);
  });

  it('fillToMaxFiles respects pathPrefix (only fills files in scope)', async () => {
    const fs: Record<string, string> = {
      'apps/api/src/Lumen.Host/Program.cs': '',
      'apps/api/src/Lumen.Modules.Capture/Features/Handler0.cs': '',
      'apps/api/src/Lumen.Modules.Capture/Features/Handler1.cs': '',
      'other-app/src/Misc.cs': '', // out of scope — must not appear
    };
    const reader: FileReader = {
      async listFiles() { return Object.keys(fs); },
      async readText(rel) { return fs[rel]; },
      async resolveImport() { return undefined; },
    };
    const r = await scanWorkspace(reader, {
      maxDepth: 3,
      maxFiles: 80,
      extensions: ['.cs'],
      pathPrefix: 'apps/api/src',
      rankBy: 'centrality',
      fillToMaxFiles: true,
    });
    expect(r.skeleton).not.toContain('other-app/src/Misc.cs');
    expect(r.skeleton.length).toBe(3);
  });

  it('fillToMaxFiles skips assembly-marker / anchor files (noise reduction)', async () => {
    // Marker classes burn skeleton slots + an LLM call to produce an empty
    // node. We exclude common .NET-style anchors from fill candidates so
    // real handler / endpoint files get those slots instead.
    const fs: Record<string, string> = {
      'src/Lumen.Host/Program.cs': '',
      'src/Lumen.Modules.Memory/AssemblyMarker.cs': '',   // marker
      'src/Lumen.Modules.Notify/AssemblyMarker.cs': '',   // marker
      'src/Lumen.Modules.Recall/ModuleAnchor.cs': '',     // marker
      'src/Lumen.Modules.Capture/Handlers/IngestUrlHandler.cs': '',
      'src/Lumen.Shared.Contracts/EventMarker.cs': '',    // NOT a marker (domain type)
    };
    const reader: FileReader = {
      async listFiles() { return Object.keys(fs); },
      async readText(rel) { return fs[rel]; },
      async resolveImport() { return undefined; },
    };
    const r = await scanWorkspace(reader, {
      maxDepth: 3,
      maxFiles: 80,
      extensions: ['.cs'],
      rankBy: 'centrality',
      fillToMaxFiles: true,
    });
    expect(r.skeleton).toContain('src/Lumen.Host/Program.cs');
    expect(r.skeleton).toContain('src/Lumen.Modules.Capture/Handlers/IngestUrlHandler.cs');
    expect(r.skeleton).toContain('src/Lumen.Shared.Contracts/EventMarker.cs');
    expect(r.skeleton).not.toContain('src/Lumen.Modules.Memory/AssemblyMarker.cs');
    expect(r.skeleton).not.toContain('src/Lumen.Modules.Notify/AssemblyMarker.cs');
    expect(r.skeleton).not.toContain('src/Lumen.Modules.Recall/ModuleAnchor.cs');
  });

  describe('inbound adjacency (v3.7)', () => {
    it('exposes a map of who-imports-me built during BFS', async () => {
      const reader = makeReader({
        'src/main.ts': `import { a } from './a'; import { b } from './b';`,
        'src/a.ts': `import { c } from './c';`,
        'src/b.ts': `import { c } from './c';`,
        'src/c.ts': `export const c = 1;`,
      });
      const r = await scanWorkspace(reader);
      // main is a seed → nobody imports it in our scan
      expect(r.inbound.get('src/main.ts')).toBeUndefined();
      // a and b are each imported by main
      expect(r.inbound.get('src/a.ts')).toEqual(['src/main.ts']);
      expect(r.inbound.get('src/b.ts')).toEqual(['src/main.ts']);
      // c is imported by both a and b
      expect(r.inbound.get('src/c.ts')?.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('drops callers that did not survive the skeleton cut', async () => {
      const fs: Record<string, string> = {
        'src/main.ts': `import { a } from './a';`,
        'src/a.ts': `export const a = 1;`,
      };
      // Add many extra files so maxFiles=2 forces overflow.
      for (let i = 0; i < 5; i++) {
        fs['src/main.ts'] += `import './extra${i}';`;
        fs[`src/extra${i}.ts`] = `import { a } from './a';`;
      }
      const reader = makeReader(fs);
      const r = await scanWorkspace(reader, {
        maxDepth: 3,
        maxFiles: 2, // only main + a
        extensions: ['.ts'],
      });
      expect(r.skeleton).toEqual(['src/main.ts', 'src/a.ts']);
      // a's inbound should only include main, not the overflowed extras
      // (even though they statically imported a, they are not in the
      // analyzed set so listing them would mislead the LLM).
      expect(r.inbound.get('src/a.ts')).toEqual(['src/main.ts']);
    });

    it('is empty when the scan finds no entry points', async () => {
      const reader = makeReader({ 'src/util.ts': 'export const x = 1;' });
      const r = await scanWorkspace(reader);
      expect(r.inbound.size).toBe(0);
    });

    it('handles C# fill-only workspaces (no BFS expansion → empty inbound)', async () => {
      // C# `using` does not resolve to files, so fill is the only way the
      // skeleton grows past entries. With no resolvable imports, inbound
      // stays empty — that's correct: the LLM gets "no scan signal" and
      // falls back to per-language triggers.
      const fs: Record<string, string> = {
        'apps/api/src/Lumen.Host/Program.cs': 'using System;',
        'apps/api/src/Lumen.Modules.X/Handler.cs': 'using System;',
      };
      const reader: FileReader = {
        async listFiles() { return Object.keys(fs); },
        async readText(rel) { return fs[rel]; },
        async resolveImport() { return undefined; },
      };
      const r = await scanWorkspace(reader, {
        maxDepth: 3,
        maxFiles: 80,
        extensions: ['.cs'],
        rankBy: 'centrality',
        fillToMaxFiles: true,
      });
      expect(r.skeleton.length).toBe(2);
      expect(r.inbound.size).toBe(0);
    });
  });
});
