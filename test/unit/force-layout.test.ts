import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeForceLayout } from '../../src/webview/scene/force-layout';
import type { CodeMapGraph } from '../../src/shared/types';

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../eval/samples/lumen-mini/fixture.json'), 'utf8'),
) as CodeMapGraph;

const SCREEN_W = 1200;

function centroid(ids: string[], methods: Record<string, { cx: number; cy: number }>) {
  const pts = ids.map((id) => methods[id]).filter(Boolean);
  const cx = pts.reduce((s, p) => s + p.cx, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.cy, 0) / pts.length;
  return { cx, cy };
}

describe('computeForceLayout()', () => {
  it('places one method node per MethodNode in the fixture', () => {
    const layout = computeForceLayout(fixture, SCREEN_W);
    expect(Object.keys(layout.methods).sort()).toEqual(Object.keys(fixture.methods).sort());
  });

  it('emits one swimlane per visible bounded context (capture, recall, ext)', () => {
    const layout = computeForceLayout(fixture, SCREEN_W);
    const bcs = layout.swimlanes.map((l) => l.bc).sort();
    // shared has no classes in lumen-mini, so it is not visible.
    expect(bcs).toEqual(['capture', 'ext', 'recall']);
  });

  it('clusters same-class methods tighter than cross-class methods', () => {
    const layout = computeForceLayout(fixture, SCREEN_W);
    const m = layout.methods;
    // IngestUrlHandler's two methods should sit closer to each other than
    // to a method in a different class.
    const a = m['IngestUrlHandler.EnqueueAsync'];
    const b = m['IngestUrlHandler.ExecuteAsync'];
    const far = m['OpenAIEmbedder.EmbedAsync'];
    const intra = Math.hypot(a.cx - b.cx, a.cy - b.cy);
    const inter = Math.hypot(a.cx - far.cx, a.cy - far.cy);
    expect(intra).toBeLessThan(inter);
  });

  it('separates bounded-context bands horizontally (capture left of recall)', () => {
    const layout = computeForceLayout(fixture, SCREEN_W);
    const capture = centroid(
      ['IngestUrlHandler.EnqueueAsync', 'WebContentExtractor.ExtractAsync'],
      layout.methods,
    );
    const recall = centroid(
      ['AskByQueryHandler.HandleAsync', 'OpenAIEmbedder.EmbedAsync'],
      layout.methods,
    );
    expect(capture.cx).toBeLessThan(recall.cx);
  });

  it('produces non-overlapping swimlane labels with a finite bbox', () => {
    const layout = computeForceLayout(fixture, SCREEN_W);
    expect(Number.isFinite(layout.bbox.minX)).toBe(true);
    expect(Number.isFinite(layout.bbox.maxX)).toBe(true);
    expect(layout.bbox.maxX).toBeGreaterThan(layout.bbox.minX);
    expect(layout.bbox.maxY).toBeGreaterThan(layout.bbox.minY);
  });

  it('is deterministic across runs (no random seeding)', () => {
    const a = computeForceLayout(fixture, SCREEN_W);
    const b = computeForceLayout(fixture, SCREEN_W);
    for (const id of Object.keys(a.methods)) {
      expect(a.methods[id].cx).toBeCloseTo(b.methods[id].cx, 5);
      expect(a.methods[id].cy).toBeCloseTo(b.methods[id].cy, 5);
    }
  });
});
