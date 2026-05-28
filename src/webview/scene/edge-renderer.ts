import { Graphics } from 'pixi.js';
import type { MethodEdge } from '../../shared/types';
import {
  type Bezier,
  type Pt,
  type Router,
  bezierTangent,
  sampleBezier,
} from './edge-routing';

const NEUTRAL_EDGE = 0xc0c8d2;
const DIM_EDGE = 0x858585;

export function renderEdges(
  edges: readonly MethodEdge[],
  router: Router,
  edgesG: Graphics,
): void {
  for (const e of edges) {
    const bz = router.bezierForEdge(e);
    if (!bz) continue;
    drawEdgeStroke(edgesG, e, bz);
    drawArrowhead(edgesG, e, bz);
  }
}

function drawEdgeStroke(g: Graphics, e: MethodEdge, bz: Bezier): void {
  const { p0, p1, p2, p3 } = bz;
  const isExt = e.kind === 'external_calls' || e.target.startsWith('ext:');
  const color = !e.verified ? DIM_EDGE : NEUTRAL_EDGE;
  const alpha = !e.verified ? 0.65 : isExt ? 0.75 : 0.9;
  const dashed = !e.verified || isExt;

  if (dashed) {
    const pts = sampleBezier(p0, p1, p2, p3, 48);
    dashAlongPolyline(g, pts, 6, 5);
    g.stroke({ color, width: 1.2, alpha });
  } else {
    g
      .moveTo(p0.x, p0.y)
      .bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y)
      .stroke({ color, width: 1.4, alpha });
  }
}

function drawArrowhead(g: Graphics, e: MethodEdge, bz: Bezier): void {
  const { p0, p1, p2, p3 } = bz;
  const isExt = e.kind === 'external_calls' || e.target.startsWith('ext:');
  const color = !e.verified ? DIM_EDGE : NEUTRAL_EDGE;
  const alpha = !e.verified ? 0.65 : isExt ? 0.75 : 0.9;
  const tan = bezierTangent(1, p0, p1, p2, p3);
  const tlen = Math.hypot(tan.x, tan.y);
  if (tlen <= 0.01) return;
  const ux = tan.x / tlen;
  const uy = tan.y / tlen;
  const tipX = p3.x - ux * 8;
  const tipY = p3.y - uy * 8;
  const leftX = tipX - uy * 3.5;
  const leftY = tipY + ux * 3.5;
  const rightX = tipX + uy * 3.5;
  const rightY = tipY - ux * 3.5;
  g
    .moveTo(p3.x, p3.y)
    .lineTo(leftX, leftY)
    .lineTo(rightX, rightY)
    .closePath()
    .fill({ color, alpha });
}

function dashAlongPolyline(g: Graphics, pts: readonly Pt[], segLen: number, gapLen: number): void {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = cum[cum.length - 1];
  const step = segLen + gapLen;
  function lerpAt(d: number): Pt {
    if (d <= 0) return pts[0];
    if (d >= total) return pts[pts.length - 1];
    let lo = 0, hi = cum.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const t = (d - cum[lo]) / (cum[lo + 1] - cum[lo] || 1);
    return {
      x: pts[lo].x + (pts[lo + 1].x - pts[lo].x) * t,
      y: pts[lo].y + (pts[lo + 1].y - pts[lo].y) * t,
    };
  }
  let d = 0;
  while (d < total) {
    const dEnd = Math.min(d + segLen, total);
    const a = lerpAt(d), b = lerpAt(dEnd);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    d += step;
  }
}
