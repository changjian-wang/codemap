// Phase 3.2 -- bounded-context classifier tests.
//
// Acceptance for v4-plan section 3.2: lumen-mini fixture's BC assignments
// match the v2 fixture's `boundedContext` field. We assert classify() output
// for every class entry in fixture.json equals the entry's boundedContext.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyBoundedContext,
  bucketAll,
  classify,
} from '../../../src/orchestrator/bc-classifier';
import type { CodeMapGraph, ClassNode } from '../../../src/shared/types';

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../eval/samples/lumen-mini/fixture.json'), 'utf8')
) as CodeMapGraph;

describe('classify() rule branches', () => {
  it('Lumen.Modules.<Name> -> module bucket', () => {
    expect(
      classify('apps/api/src/Lumen.Modules.Capture/Features/IngestUrl/IngestUrlHandler.cs')
    ).toEqual({ bucket: 'capture', rule: 'lumen_module' });
    expect(
      classify('apps/api/src/Lumen.Modules.Recall/Features/AskByQuery/AskByQueryHandler.cs')
    ).toEqual({ bucket: 'recall', rule: 'lumen_module' });
  });

  it('Lumen.Host -> host bucket', () => {
    expect(classify('apps/api/src/Lumen.Host/Program.cs')).toEqual({
      bucket: 'host',
      rule: 'lumen_host',
    });
  });

  it('Lumen.Shared.* -> shared bucket', () => {
    expect(classify('apps/api/src/Lumen.Shared.Infrastructure/Persistence/MigrationRunner.cs'))
      .toEqual({ bucket: 'shared', rule: 'lumen_shared' });
  });

  it('packages/<name>/ -> package bucket', () => {
    expect(classify('packages/recall-mcp/src/index.ts')).toEqual({
      bucket: 'recall_mcp',
      rule: 'monorepo_package',
    });
  });

  it('apps/<name>/ -> app bucket', () => {
    expect(classify('apps/desktop/src/main.ts')).toEqual({
      bucket: 'desktop',
      rule: 'monorepo_app',
    });
  });

  it('src/<name>/ -> root bucket (no monorepo prefix)', () => {
    expect(classify('src/orchestrator/analyze-file.ts')).toEqual({
      bucket: 'orchestrator',
      rule: 'src_root',
    });
  });

  it('unknown layout -> fallback shared', () => {
    expect(classify('vendor/wild-card.cs')).toEqual({ bucket: 'shared', rule: 'fallback' });
  });

  it('normalizes hyphens to underscores and lowercases the bucket', () => {
    expect(classify('packages/my-Module/index.ts').bucket).toBe('my_module');
  });

  it('handles backslash paths (Windows checkout)', () => {
    expect(classify('apps\\api\\src\\Lumen.Modules.Capture\\Foo.cs')).toEqual({
      bucket: 'capture',
      rule: 'lumen_module',
    });
  });
});

describe('classify() acceptance against lumen-mini fixture', () => {
  it('every fixture ClassNode\'s file path classifies to its declared boundedContext', () => {
    for (const cls of Object.values(fixture.classes)) {
      const actual = classify(cls.file).bucket;
      expect(actual, `mismatch for ${cls.id} at ${cls.file}`).toBe(cls.boundedContext);
    }
  });
});

describe('bucketAll() palette cap', () => {
  it('keeps the top (paletteCap - 1) buckets plus shared', () => {
    const files = [
      // capture x3
      'apps/api/src/Lumen.Modules.Capture/A.cs',
      'apps/api/src/Lumen.Modules.Capture/B.cs',
      'apps/api/src/Lumen.Modules.Capture/C.cs',
      // recall x2
      'apps/api/src/Lumen.Modules.Recall/A.cs',
      'apps/api/src/Lumen.Modules.Recall/B.cs',
      // host x1
      'apps/api/src/Lumen.Host/Program.cs',
      // shared x1
      'apps/api/src/Lumen.Shared.Infrastructure/X.cs',
      // a rare bucket
      'apps/api/src/Lumen.Modules.Search/Z.cs',
    ];
    const bucketed = bucketAll(files, 3); // keep top 2 + shared
    const buckets = new Set(bucketed.map((b) => b.bucket));
    expect(buckets.has('capture')).toBe(true);
    expect(buckets.has('recall')).toBe(true);
    expect(buckets.has('shared')).toBe(true);
    // search/host collapse into shared
    expect(buckets.has('search')).toBe(false);
    expect(buckets.has('host')).toBe(false);
  });
});

describe('applyBoundedContext()', () => {
  it('mutates classes in place, returns palette ordered by frequency with shared last', () => {
    const classes: ClassNode[] = [
      mkClass('A', 'apps/api/src/Lumen.Modules.Capture/A.cs'),
      mkClass('B', 'apps/api/src/Lumen.Modules.Capture/B.cs'),
      mkClass('C', 'apps/api/src/Lumen.Modules.Recall/C.cs'),
      mkClass('D', 'apps/api/src/Lumen.Shared.Infrastructure/D.cs'),
    ];
    const palette = applyBoundedContext(classes);
    expect(classes.map((c) => c.boundedContext)).toEqual([
      'capture',
      'capture',
      'recall',
      'shared',
    ]);
    expect(palette).toEqual(['capture', 'recall', 'shared']);
  });
});

function mkClass(id: string, file: string): ClassNode {
  return {
    id,
    kind: 'class',
    boundedContext: '',
    file,
    range: { startLine: 1, endLine: 10 },
    intent: '',
    confidence: 0.5,
    risks: [],
    methodIds: [],
    verification: 'unverified',
  };
}
