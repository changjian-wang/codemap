import { describe, expect, it } from 'vitest';
import {
  buildRouter,
  type CardRect,
  type EdgeRef,
  type PillRect,
  type RoutingInput,
} from '../../src/webview/scene/edge-routing';

// Helpers to build minimal fixtures for the four routing branches.

function pill(opts: { bc: string; left: number; cy: number; width?: number }): PillRect {
  const w = opts.width ?? 100;
  return {
    cy: opts.cy,
    bc: opts.bc,
    pillL: opts.left,
    pillR: opts.left + w,
    pillCx: opts.left + w / 2,
    pillCy: opts.cy,
  };
}

function card(opts: { x: number; y: number; w?: number; h?: number }): CardRect {
  return { x: opts.x, y: opts.y, w: opts.w ?? 200, h: opts.h ?? 60 };
}

function makeInput(args: {
  methods?: Record<string, PillRect>;
  classes?: Record<string, CardRect>;
}): RoutingInput {
  return { methods: args.methods ?? {}, classes: args.classes ?? {}, pillH: 22 };
}

describe('edge-routing buildRouter()', () => {
  it('returns null when neither endpoint is in the layout', () => {
    const router = buildRouter(makeInput({}), []);
    expect(router.bezierForEdge({ id: 'x', source: 'a', target: 'b' })).toBeNull();
  });

  describe('orient = "v"', () => {
    it('same-lane downward → exits source B, enters target T', () => {
      const input = makeInput({
        methods: {
          a: pill({ bc: 'capture', left: 100, cy: 100 }),
          b: pill({ bc: 'capture', left: 100, cy: 300 }),
        },
      });
      const edges: EdgeRef[] = [{ id: 'e0', source: 'a', target: 'b' }];
      const bz = buildRouter(input, edges).bezierForEdge(edges[0]);
      expect(bz?.orient).toBe('v');
      expect(bz?.p0.y).toBeCloseTo(100 + 22 / 2);
      expect(bz?.p3.y).toBeCloseTo(300 - 22 / 2);
    });
  });

  describe('orient = "h"', () => {
    it('cross-lane forward, balanced dy/dx → standard sankey out R into L', () => {
      const input = makeInput({
        methods: {
          a: pill({ bc: 'capture', left: 100, cy: 200 }),
          b: pill({ bc: 'ext', left: 400, cy: 220 }),
        },
      });
      const edges: EdgeRef[] = [{ id: 'e1', source: 'a', target: 'b' }];
      const bz = buildRouter(input, edges).bezierForEdge(edges[0]);
      expect(bz?.orient).toBe('h');
      // Endpoint tangent is horizontal: p2.y == p3.y.
      expect(bz?.p2.y).toBeCloseTo(bz!.p3.y);
    });
  });

  describe('orient = "v-fwd"', () => {
    it('cross-lane forward with |dy| ≫ dx → exits source B, enters target L', () => {
      // Reproduce the e7 (HandleAsync → GroundedAskPromptsV2) geometry:
      // source pill at cy=174; target ext card mid at y=526; horizontal
      // run only ~126. |dy|/max(dx,80) ≈ 2.79 > 2.5 → v-fwd branch.
      const input = makeInput({
        methods: {
          src: pill({ bc: 'recall', left: 295, cy: 174, width: 140 }),
        },
        classes: {
          tgt: card({ x: 560, y: 490, w: 249, h: 72 }),
        },
      });
      const edges: EdgeRef[] = [{ id: 'e7', source: 'src', target: 'tgt' }];
      const bz = buildRouter(input, edges).bezierForEdge(edges[0]);
      expect(bz?.orient).toBe('v-fwd');
      // p0 must exit the source pill's bottom (cy + pillH/2 = 174 + 11 = 185).
      expect(bz?.p0.y).toBeCloseTo(174 + 11);
      // p3 must land on the target card's left mid (x=560, y=526).
      expect(bz?.p3).toEqual({ x: 560, y: 526 });
      // Endpoint tangent stays horizontal → p2.y == p3.y so the arrow
      // enters the card cleanly without skew.
      expect(bz?.p2.y).toBeCloseTo(bz!.p3.y);
    });

    it('does NOT trigger when |dy|/dx ratio is below the threshold', () => {
      const input = makeInput({
        methods: { src: pill({ bc: 'recall', left: 100, cy: 100, width: 80 }) },
        classes: { tgt: card({ x: 400, y: 120, w: 200, h: 40 }) },
      });
      const edges: EdgeRef[] = [{ id: 'e', source: 'src', target: 'tgt' }];
      const bz = buildRouter(input, edges).bezierForEdge(edges[0]);
      expect(bz?.orient).toBe('h');
    });
  });

  describe('orient = "h-rev"', () => {
    it('cross-lane reverse (target left of source) → sag with horizontal endpoint', () => {
      const input = makeInput({
        methods: {
          a: pill({ bc: 'recall', left: 400, cy: 200, width: 80 }),
          b: pill({ bc: 'capture', left: 100, cy: 220, width: 80 }),
        },
      });
      const edges: EdgeRef[] = [{ id: 'er', source: 'a', target: 'b' }];
      const bz = buildRouter(input, edges).bezierForEdge(edges[0]);
      expect(bz?.orient).toBe('h-rev');
      // Endpoint tangent horizontal: p2.y == p3.y; arrow enters target R cleanly.
      expect(bz?.p2.y).toBeCloseTo(bz!.p3.y);
    });
  });

  describe('attachOff() co-side fanning', () => {
    it('returns 0 when only one edge lives on a pill side', () => {
      const input = makeInput({
        methods: {
          a: pill({ bc: 'capture', left: 100, cy: 100 }),
          b: pill({ bc: 'capture', left: 100, cy: 300 }),
        },
      });
      const edges: EdgeRef[] = [{ id: 'e0', source: 'a', target: 'b' }];
      const router = buildRouter(input, edges);
      expect(router.attachOff('a', 'B', edges[0])).toBe(0);
    });

    it('fans co-side edges symmetrically around 0', () => {
      const input = makeInput({
        methods: {
          src: pill({ bc: 'capture', left: 100, cy: 100 }),
          t1: pill({ bc: 'capture', left: 100, cy: 300 }),
          t2: pill({ bc: 'capture', left: 100, cy: 400 }),
        },
      });
      const edges: EdgeRef[] = [
        { id: 'e1', source: 'src', target: 't1' },
        { id: 'e2', source: 'src', target: 't2' },
      ];
      const router = buildRouter(input, edges);
      const o1 = router.attachOff('src', 'B', edges[0]);
      const o2 = router.attachOff('src', 'B', edges[1]);
      expect(o1).toBeCloseTo(-o2);
      expect(o1).not.toBe(0);
    });
  });
});
