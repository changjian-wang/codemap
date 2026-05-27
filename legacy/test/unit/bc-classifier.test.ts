import { describe, it, expect } from 'vitest';
import { classify, bucketAll } from '../../src/orchestrator/bc-classifier';

describe('classify (single-file)', () => {
  it.each([
    [
      'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs',
      'capture', 'lumen_module',
    ],
    [
      'apps/api/src/Lumen.Modules.Recall/Features/AskByQuery/AskByQueryHandler.cs',
      'recall', 'lumen_module',
    ],
    [
      'apps/api/src/Lumen.Shared.Infrastructure/Embeddings/OnnxEmbeddingService.cs',
      'shared', 'lumen_shared',
    ],
    [
      'apps/api/src/Lumen.Host/Program.cs',
      'host', 'lumen_host',
    ],
    [
      'packages/auth/src/UserService.ts',
      'auth', 'monorepo_package',
    ],
    [
      'apps/admin/src/views/UserList.vue',
      'admin', 'monorepo_app',
    ],
    [
      'src/foo/bar.ts',
      'foo', 'src_root',
    ],
    [
      'README.md',
      'shared', 'fallback',
    ],
  ])('%s → bucket=%s rule=%s', (file, bucket, rule) => {
    const out = classify(file);
    expect(out.bucket).toBe(bucket);
    expect(out.rule).toBe(rule);
  });

  it('handles backslash paths (Windows)', () => {
    expect(classify('apps\\api\\src\\Lumen.Modules.Connect\\Foo.cs').bucket).toBe('connect');
  });

  it('lowercases module names and strips non-alphanumeric', () => {
    expect(classify('apps/api/src/Lumen.Modules.MyModule/Foo.cs').bucket).toBe('mymodule');
  });
});

describe('bucketAll (palette cap)', () => {
  it('keeps the top (cap-1) buckets plus a guaranteed "shared" slot', () => {
    const files = [
      'apps/api/src/Lumen.Modules.Capture/A.cs',
      'apps/api/src/Lumen.Modules.Capture/B.cs',
      'apps/api/src/Lumen.Modules.Capture/C.cs',
      'apps/api/src/Lumen.Modules.Recall/A.cs',
      'apps/api/src/Lumen.Modules.Recall/B.cs',
      'apps/api/src/Lumen.Modules.Memory/A.cs',         // rarer
      'apps/api/src/Lumen.Modules.Notify/A.cs',         // rarest — should collapse
      'apps/api/src/Lumen.Host/Program.cs',
      'apps/api/src/Lumen.Shared.Infrastructure/X.cs',
    ];
    const out = bucketAll(files, 4);
    const buckets = new Set(out.map(o => o.bucket));
    expect(buckets.size).toBeLessThanOrEqual(4);
    // capture and recall are the two most populous — must survive
    expect(buckets.has('capture')).toBe(true);
    expect(buckets.has('recall')).toBe(true);
    // shared always reserved
    expect(buckets.has('shared')).toBe(true);
    // notify should collapse to shared (rarest)
    const notifyEntry = out.find(o => o.file.includes('Notify'));
    expect(notifyEntry?.bucket).toBe('shared');
  });

  it('keeps everything when distinct buckets ≤ cap', () => {
    const files = [
      'apps/api/src/Lumen.Modules.Capture/A.cs',
      'apps/api/src/Lumen.Modules.Recall/A.cs',
      'apps/api/src/Lumen.Host/Program.cs',
    ];
    const out = bucketAll(files, 4);
    expect(new Set(out.map(o => o.bucket))).toEqual(new Set(['capture', 'recall', 'host']));
  });
});
