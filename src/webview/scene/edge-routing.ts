// Pure edge geometry — no Pixi, no DOM. Testable in isolation.
//
// Three routing branches:
//   v      same lane → vertical sankey (out source's B/T, into target's T/B)
//   h      cross-lane forward L→R → horizontal sankey
//   v-fwd  cross-lane forward with |dy| ≫ dx → out source's B/T, into target's L
//          (avoids the L-shape that grazes intermediate cards stacked between
//          source and target in the destination lane)
//   h-rev  cross-lane reverse R→L → sag below intermediate cards with
//          p2.y === p3.y to keep endpoint tangent horizontal

export type Orient = 'v' | 'v-fwd' | 'h' | 'h-rev';

export interface Pt {
  x: number;
  y: number;
}

export interface Bezier {
  p0: Pt;
  p1: Pt;
  p2: Pt;
  p3: Pt;
  orient: Orient;
}

/** Method pill geometry — pillL/R/Cx/Cy are filled by the node renderer. */
export interface PillRect {
  cy: number;
  bc: string;
  pillL: number;
  pillR: number;
  pillCx: number;
  pillCy: number;
}

/** Class / ext / stub card bounding box. */
export interface CardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RoutingInput {
  methods: Record<string, PillRect>;
  classes: Record<string, CardRect>;
  pillH: number;
}

export interface EdgeRef {
  id: string;
  source: string;
  target: string;
}

export interface Sides {
  sSide: 'L' | 'R' | 'T' | 'B';
  tSide: 'L' | 'R' | 'T' | 'B';
  sOther: number;
  tOther: number;
}

const ATTACH_SPACING = 10;

/** Vertical-dominant threshold: |dy| > max(dx, MIN_DX) * RATIO. */
const VFWD_MIN_DX = 80;
const VFWD_RATIO = 2.5;

export interface Router {
  edgeSides(ed: EdgeRef): Sides | null;
  attachOff(pillId: string, side: 'L' | 'R' | 'T' | 'B', ed: EdgeRef): number;
  bezierForEdge(ed: EdgeRef): Bezier | null;
}

export function buildRouter(input: RoutingInput, edges: readonly EdgeRef[]): Router {
  const { methods, classes, pillH } = input;

  function edgeSides(ed: EdgeRef): Sides | null {
    const sLayout = methods[ed.source];
    const tLayout = methods[ed.target];
    const sClass = classes[ed.source];
    const tClass = classes[ed.target];
    if (!(sLayout || sClass) || !(tLayout || tClass)) return null;

    if (sLayout && tLayout && sLayout.bc === tLayout.bc) {
      const down = sLayout.cy <= tLayout.cy;
      return {
        sSide: down ? 'B' : 'T',
        tSide: down ? 'T' : 'B',
        sOther: tLayout.pillCx,
        tOther: sLayout.pillCx,
      };
    }

    const aRightX = sLayout ? sLayout.pillR : sClass!.x + sClass!.w;
    const bLeftX = tLayout ? tLayout.pillL : tClass!.x;
    const fwd = bLeftX >= aRightX - 20;

    if (fwd && sLayout) {
      const sCy = sLayout.cy;
      const tCy = tLayout ? tLayout.pillCy : tClass!.y + tClass!.h / 2;
      const dx = bLeftX - aRightX;
      const dy = tCy - sCy;
      if (Math.abs(dy) > Math.max(dx, VFWD_MIN_DX) * VFWD_RATIO) {
        const down = dy > 0;
        return {
          sSide: down ? 'B' : 'T',
          tSide: 'L',
          sOther: bLeftX,
          tOther: sLayout.pillCy,
        };
      }
    }

    return {
      sSide: fwd ? 'R' : 'L',
      tSide: fwd ? 'L' : 'R',
      sOther: tLayout ? tLayout.pillCy : tClass!.y + tClass!.h / 2,
      tOther: sLayout ? sLayout.pillCy : sClass!.y + sClass!.h / 2,
    };
  }

  type AttachKey = string;
  const attachments = new Map<AttachKey, { ed: EdgeRef; other: number }[]>();

  for (const ed of edges) {
    const s = edgeSides(ed);
    if (!s) continue;
    if (methods[ed.source]) {
      const key = `${ed.source}@${s.sSide}`;
      const list = attachments.get(key) ?? [];
      list.push({ ed, other: s.sOther });
      attachments.set(key, list);
    }
    if (methods[ed.target]) {
      const key = `${ed.target}@${s.tSide}`;
      const list = attachments.get(key) ?? [];
      list.push({ ed, other: s.tOther });
      attachments.set(key, list);
    }
  }
  for (const list of attachments.values()) list.sort((a, b) => a.other - b.other);

  function attachOff(pillId: string, side: 'L' | 'R' | 'T' | 'B', ed: EdgeRef): number {
    const list = attachments.get(`${pillId}@${side}`);
    if (!list || list.length <= 1) return 0;
    const i = list.findIndex((x) => x.ed === ed);
    if (i < 0) return 0;
    return (i - (list.length - 1) / 2) * ATTACH_SPACING;
  }

  function bezierForEdge(ed: EdgeRef): Bezier | null {
    const sLayout = methods[ed.source];
    const tLayout = methods[ed.target];
    const sClass = classes[ed.source];
    const tClass = classes[ed.target];
    if (!(sLayout || sClass) || !(tLayout || tClass)) return null;

    // Same lane → vertical sankey
    if (sLayout && tLayout && sLayout.bc === tLayout.bc) {
      const down = sLayout.cy <= tLayout.cy;
      const sxo = attachOff(ed.source, down ? 'B' : 'T', ed);
      const txo = attachOff(ed.target, down ? 'T' : 'B', ed);
      const a = down
        ? { x: sLayout.pillCx + sxo, y: sLayout.cy + pillH / 2 }
        : { x: sLayout.pillCx + sxo, y: sLayout.cy - pillH / 2 };
      const b = down
        ? { x: tLayout.pillCx + txo, y: tLayout.cy - pillH / 2 }
        : { x: tLayout.pillCx + txo, y: tLayout.cy + pillH / 2 };
      const dy = b.y - a.y;
      return {
        p0: a,
        p1: { x: a.x, y: a.y + dy * 0.3 },
        p2: { x: b.x, y: a.y + dy * 0.7 },
        p3: b,
        orient: 'v',
      };
    }

    const aRightX = sLayout ? sLayout.pillR : sClass!.x + sClass!.w;
    const bLeftX = tLayout ? tLayout.pillL : tClass!.x;
    const fwd = bLeftX >= aRightX - 20;

    // Vertical-dominant forward
    if (fwd && sLayout) {
      const sCy = sLayout.cy;
      const tCy = tLayout ? tLayout.pillCy : tClass!.y + tClass!.h / 2;
      const dxRaw = bLeftX - aRightX;
      const dyRaw = tCy - sCy;
      if (Math.abs(dyRaw) > Math.max(dxRaw, VFWD_MIN_DX) * VFWD_RATIO) {
        const down = dyRaw > 0;
        const sxo = attachOff(ed.source, down ? 'B' : 'T', ed);
        const tLOff = tLayout ? attachOff(ed.target, 'L', ed) : 0;
        const sy0 = down ? sLayout.cy + pillH / 2 : sLayout.cy - pillH / 2;
        const a = { x: sLayout.pillCx + sxo, y: sy0 };
        const b = tLayout
          ? { x: tLayout.pillL, y: tLayout.pillCy + tLOff }
          : { x: tClass!.x, y: tClass!.y + tClass!.h / 2 };
        const ndy = b.y - a.y;
        return {
          p0: a,
          p1: { x: a.x, y: a.y + ndy * 0.45 },
          p2: { x: b.x - 60, y: b.y },
          p3: b,
          orient: 'v-fwd',
        };
      }
    }

    // Forward L→R standard sankey
    if (fwd) {
      const sROff = sLayout ? attachOff(ed.source, 'R', ed) : 0;
      const tLOff = tLayout ? attachOff(ed.target, 'L', ed) : 0;
      const a = sLayout
        ? { x: sLayout.pillR, y: sLayout.pillCy + sROff }
        : { x: sClass!.x + sClass!.w, y: sClass!.y + sClass!.h / 2 };
      const b = tLayout
        ? { x: tLayout.pillL, y: tLayout.pillCy + tLOff }
        : { x: tClass!.x, y: tClass!.y + tClass!.h / 2 };
      const dx = b.x - a.x;
      return {
        p0: a,
        p1: { x: a.x + dx * 0.3, y: a.y },
        p2: { x: a.x + dx * 0.7, y: b.y },
        p3: b,
        orient: 'h',
      };
    }

    // Reverse R→L — sag below with horizontal endpoint tangent
    const sLOff = sLayout ? attachOff(ed.source, 'L', ed) : 0;
    const tROff = tLayout ? attachOff(ed.target, 'R', ed) : 0;
    const a = sLayout
      ? { x: sLayout.pillL, y: sLayout.pillCy + sLOff }
      : { x: sClass!.x, y: sClass!.y + sClass!.h / 2 };
    const b = tLayout
      ? { x: tLayout.pillR, y: tLayout.pillCy + tROff }
      : { x: tClass!.x + tClass!.w, y: tClass!.y + tClass!.h / 2 };
    const sag = Math.max(80, Math.abs(b.x - a.x) * 0.18);
    const sagY = Math.max(a.y, b.y) + sag;
    return {
      p0: a,
      p1: { x: a.x - 60, y: sagY },
      p2: { x: b.x + 60, y: b.y },
      p3: b,
      orient: 'h-rev',
    };
  }

  return { edgeSides, attachOff, bezierForEdge };
}

// =========================================================================
//   Bezier math helpers (used by edge-renderer + interaction hit-test)
// =========================================================================

export function bezierPt(t: number, p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

export function bezierTangent(t: number, p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt {
  const u = 1 - t;
  return {
    x: 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
    y: 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
  };
}

export function sampleBezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) pts.push(bezierPt(i / n, p0, p1, p2, p3));
  return pts;
}
