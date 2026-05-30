// Phase 3.3a -- scanWorkspace unit tests.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTENSIONS,
  scanWorkspace,
  type FileReader,
  type ScanOptions,
} from '../../../src/orchestrator/workspace-scanner';

function reader(files: string[]): FileReader {
  return {
    listFiles: async () => [...files],
    readText: async () => undefined,
  };
}

const ALL_LUMEN_FILES = [
  'apps/api/src/Lumen.Modules.Capture/Features/IngestUrl/IngestUrlHandler.cs',
  'apps/api/src/Lumen.Modules.Capture/Adapters/WebContentExtractor.cs',
  'apps/api/src/Lumen.Modules.Capture/Persistence/ChunkStore.cs',
  'apps/api/src/Lumen.Modules.Recall/Features/AskByQuery/AskByQueryHandler.cs',
  'apps/api/src/Lumen.Modules.Recall/Adapters/OpenAIEmbedder.cs',
  'apps/api/src/Lumen.Host/Program.cs',
  'apps/desktop/src/main/index.ts',
  'README.md',
  'package.json',
];

describe('scanWorkspace', () => {
  it('filters by extension', async () => {
    const out = await scanWorkspace(reader(ALL_LUMEN_FILES), {
      extensions: ['.cs'],
      maxFiles: 100,
    });
    expect(out.every((f) => f.endsWith('.cs'))).toBe(true);
    expect(out).toHaveLength(6);
  });

  it('respects scopePrefix', async () => {
    const out = await scanWorkspace(reader(ALL_LUMEN_FILES), {
      extensions: [...DEFAULT_EXTENSIONS],
      maxFiles: 100,
      scopePrefix: 'apps/api/src/Lumen.Modules.Capture',
    });
    expect(out).toHaveLength(3);
    for (const f of out) {
      expect(f.startsWith('apps/api/src/Lumen.Modules.Capture/')).toBe(true);
    }
  });

  it('normalizes backslash prefix + trailing slashes', async () => {
    const out = await scanWorkspace(reader(ALL_LUMEN_FILES), {
      extensions: [...DEFAULT_EXTENSIONS],
      maxFiles: 100,
      scopePrefix: 'apps\\api\\src\\Lumen.Modules.Recall\\',
    });
    expect(out.map((f) => f.split('/').pop())).toEqual(
      expect.arrayContaining(['AskByQueryHandler.cs', 'OpenAIEmbedder.cs']),
    );
    expect(out).toHaveLength(2);
  });

  it('sorts by depth then alphabetically (deterministic)', async () => {
    const files = [
      'src/z/deep/leaf.ts',
      'src/a/file.ts',
      'src/b/file.ts',
      'top.ts',
    ];
    const out = await scanWorkspace(reader(files), {
      extensions: ['.ts'],
      maxFiles: 100,
    });
    expect(out).toEqual(['top.ts', 'src/a/file.ts', 'src/b/file.ts', 'src/z/deep/leaf.ts']);
  });

  it('caps to maxFiles', async () => {
    const out = await scanWorkspace(reader(ALL_LUMEN_FILES), {
      extensions: ['.cs'],
      maxFiles: 2,
    });
    expect(out).toHaveLength(2);
  });

  it('returns [] when maxFiles is 0', async () => {
    const out = await scanWorkspace(reader(ALL_LUMEN_FILES), {
      extensions: ['.cs'],
      maxFiles: 0,
    });
    expect(out).toEqual([]);
  });

  it('treats backslash paths in listFiles as forward-slash', async () => {
    const r = reader([
      'apps\\api\\src\\Lumen.Modules.Capture\\IngestUrlHandler.cs',
      'apps\\api\\src\\Lumen.Modules.Recall\\OpenAIEmbedder.cs',
    ]);
    const out = await scanWorkspace(r, {
      extensions: ['.cs'],
      maxFiles: 10,
      scopePrefix: 'apps/api/src/Lumen.Modules.Capture',
    });
    expect(out).toEqual(['apps/api/src/Lumen.Modules.Capture/IngestUrlHandler.cs']);
  });
});
