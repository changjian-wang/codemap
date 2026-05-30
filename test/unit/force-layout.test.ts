// Phase 1.2 + ALL-collapsed rewrite -- class-as-node force layout.
//
// The original test suite asserted per-method placement. Post-HITL the
// layout collapses methods into class cards (ALL mode), so these tests
// validate the new class-as-node contract:
//   - one ClassLayout per class / ext / stub, methods map stays empty
//   - one swimlane per visible BC (plus 'ext' when present)
//   - same-BC cards cluster horizontally, different BCs separate
//   - bbox is finite, layout is deterministic across runs

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeForceLayout } from '../../src/webview/scene/force-layout';
import type { CodeMapGraph } from '../../src/shared/types';

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../eval/samples/lumen-mini/fixture.json'), 'utf8'),
) as CodeMapGraph;

const SCREEN_W = 1200;

function bandCenterX(layout: ReturnType<typeof computeForceLayout>, bc: string): number {
  const cards = Object.values(layout.classes).filter((c) => c.bc === bc);
  if (cards.length === 0) return NaN;
  return cards.reduce((s, c) => s + (c.x + c.w / 2), 0) / cards.length;
}

describe('computeForceLayout()', () => {
  it('places one class card per ClassNode and per externalDep (no method nodes)', () => {
    const layout = computeForceLayout(fixture, SCREEN_W);
    const cardIds = Object.keys(layout.classes);
    for (const id of Object.keys(fixture.classes)) expect(cardIds).toContain(id);
    for (const id of Object.keys(fixture.externalDeps)) expect(cardIds).toContain(id);
    // ALL-collapsed mode keeps the methods map empty.
    expect(Object.keys(layout.methods)).toEqual([]);
  });

  it('emits one swimlane per visible bounded context (capture, recall, ext)', () => {
    const layout = computeForceLayout(fixture, SCREEN_W);
    const bcs = layout.swimlanes.map((l) => l.bc).sort();
    expect(bcs).toEqual(['capture', 'ext', 'recall']);
  });

  it('separates bounded-context bands horizontally (capture left of recall left of ext)', () => {
    const layout = computeForceLayout(fixture, SCREEN_W);
    const capture = bandCenterX(layout, 'capture');
    const recall = bandCenterX(layout, 'recall');
    const ext = bandCenterX(layout, 'ext');
    expect(capture).toBeLessThan(recall);
    expect(recall).toBeLessThan(ext);
  });

  it('produces non-overlapping cards within the same BC band', () => {
    const layout = computeForceLayout(fixture, SCREEN_W);
    const captureCards = Object.values(layout.classes).filter((c) => c.bc === 'capture');
    for (let i = 0; i < captureCards.length; i++) {
      for (let j = i + 1; j < captureCards.length; j++) {
        const a = captureCards[i]!;
        const b = captureCards[j]!;
        const xOverlap = a.x < b.x + b.w && b.x < a.x + a.w;
        const yOverlap = a.y < b.y + b.h && b.y < a.y + a.h;
        expect(xOverlap && yOverlap).toBe(false);
      }
    }
  });

  it('produces a finite bbox that spans every card', () => {
    const layout = computeForceLayout(fixture, SCREEN_W);
    expect(Number.isFinite(layout.bbox.minX)).toBe(true);
    expect(Number.isFinite(layout.bbox.maxX)).toBe(true);
    expect(layout.bbox.maxX).toBeGreaterThan(layout.bbox.minX);
    expect(layout.bbox.maxY).toBeGreaterThan(layout.bbox.minY);
    for (const c of Object.values(layout.classes)) {
      expect(c.x).toBeGreaterThanOrEqual(layout.bbox.minX - 1);
      expect(c.x + c.w).toBeLessThanOrEqual(layout.bbox.maxX + 1);
    }
  });

  it('is deterministic across runs (no random seeding)', () => {
    const a = computeForceLayout(fixture, SCREEN_W);
    const b = computeForceLayout(fixture, SCREEN_W);
    for (const id of Object.keys(a.classes)) {
      expect(a.classes[id]!.x).toBeCloseTo(b.classes[id]!.x, 5);
      expect(a.classes[id]!.y).toBeCloseTo(b.classes[id]!.y, 5);
    }
  });
});
