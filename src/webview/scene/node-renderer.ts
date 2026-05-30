import { Container, Graphics, Text } from 'pixi.js';
import type { CodeMapGraph } from '../../shared/types';
import {
  type LaneLayout,
  type MethodLayout,
  CARD_PAD,
  PILL_H,
  PILL_HPAD,
} from './lane-layout';

/**
 * One renderable node = several Pixi children spread across layers (card on
 * bg, badge on node, title on label). The interaction layer dims a node by
 * setting `alpha` on every entry in this group.
 */
export type NodeGroup = Container[];

// VS-Code-dark palette, kept in sync with the R1 spike.
const BC_COLORS: Record<string, number> = {
  capture: 0x4ec9b0,
  recall: 0xc586c0,
  shared: 0x569cd6,
};
const EXT_COLOR = 0xdcdcaa;
const STUB_COLOR = 0x858585;
const ENTRY_RING = 0xf59e0b;
// Verification palette — wired to ClassNode.verification / MethodNode.verification.
// Stubs (kind='stub', class-id fallback in MethodEdge.target) are treated as
// unverified regardless of their nominal state.
const VERIFIED = 0x4caf50;
const PARTIAL = 0xf59e0b;
const UNVERIFIED = 0xf48771;
const READING_ORDER_FILL = 0x1e1e1e;
const READING_ORDER_BORDER = 0x9cdcfe;
const READING_ORDER_TEXT = 0x9cdcfe;
const PILL_FILL = 0x252526;
const TEXT_PRIMARY = 0xd4d4d4;
const PAGE_BG = 0x1e1e1e;
const MONO_FONT = 'SF Mono, Menlo, Consolas, monospace';
const SANS_FONT = 'ui-sans-serif, system-ui, sans-serif';

function bcColor(bc: string): number {
  if (bc === 'ext') return EXT_COLOR;
  return BC_COLORS[bc] ?? 0xe6e9ef;
}

export interface NodeLayers {
  bgLayer: Container;
  nodeLayer: Container;
  labelLayer: Container;
}

export function renderSwimlanes(layout: LaneLayout, layers: NodeLayers): void {
  const { bgLayer, labelLayer } = layers;
  for (const lane of layout.swimlanes) {
    const color = bcColor(lane.bc);
    const band = new Graphics();
    band
      .roundRect(lane.x, lane.y, lane.w, lane.h, 10)
      .fill({ color, alpha: 0.06 })
      .stroke({ color, width: 1, alpha: 0.35 });
    bgLayer.addChild(band);

    const label = new Text({
      text: lane.bc,
      style: { fill: color, fontSize: 14, fontWeight: '700', fontFamily: SANS_FONT },
    });
    label.x = lane.x + 12;
    label.y = lane.y + 8;
    labelLayer.addChild(label);
  }
}

export function renderClassCards(layout: LaneLayout, layers: NodeLayers): Map<string, NodeGroup> {
  const { bgLayer, nodeLayer, labelLayer } = layers;
  const byId = new Map<string, NodeGroup>();

  for (const cl of Object.values(layout.classes)) {
    const color = bcColor(cl.bc);
    const isStub = cl.kind === 'stub';
    const group: NodeGroup = [];

    // Base card: BC-tinted fill+stroke keeps the swimlane signal. Verification
    // is layered ON TOP via an overlay so the two signals stay separable.
    const card = new Graphics();
    card
      .roundRect(cl.x, cl.y, cl.w, cl.h, 12)
      .fill({ color: PAGE_BG, alpha: 1 })
      .stroke({ color, width: 2, alpha: isStub ? 0.5 : 1 });
    bgLayer.addChild(card);
    group.push(card);

    const titleStr = isStub ? `${cl.name} (unresolved)` : cl.name;
    const title = new Text({
      text: titleStr,
      style: {
        fill: isStub ? STUB_COLOR : color,
        fontSize: 12,
        fontWeight: '600',
        fontStyle: isStub ? 'italic' : 'normal',
        fontFamily: MONO_FONT,
      },
    });
    title.x = cl.x + CARD_PAD;
    title.y = cl.y + 8;
    labelLayer.addChild(title);
    group.push(title);

    // ALL-collapsed mode: show "N methods" subtitle in lieu of method pills.
    if (cl.kind === 'real' && cl.methodIds.length > 0) {
      const subtitle = new Text({
        text: `${cl.methodIds.length} method${cl.methodIds.length === 1 ? '' : 's'}`,
        style: {
          fill: TEXT_PRIMARY,
          fontSize: 10,
          fontFamily: SANS_FONT,
        },
      });
      subtitle.alpha = 0.55;
      subtitle.x = cl.x + CARD_PAD;
      subtitle.y = cl.y + 24;
      labelLayer.addChild(subtitle);
      group.push(subtitle);
    }

    if (cl.isEntry) {
      const badge = new Graphics();
      badge.circle(cl.x + cl.w - 14, cl.y + 14, 5).fill(ENTRY_RING);
      nodeLayer.addChild(badge);
      group.push(badge);
    }

    const verification = isStub ? 'unverified' : (cl.verification ?? 'unverified');
    const overlay = buildVerificationOverlay(cl.x, cl.y, cl.w, cl.h, 12, verification);
    if (overlay) {
      bgLayer.addChild(overlay);
      group.push(overlay);
    }

    byId.set(cl.id, group);
  }

  return byId;
}

/**
 * Add small numbered badges next to each pill that appears in
 * `graph.readingOrder`. The badge is a circle anchored at the pill's left
 * edge so it doesn't fight the entry triangle (which sits inside the pill).
 */
export function renderReadingOrder(
  layout: LaneLayout,
  graph: CodeMapGraph,
  layers: NodeLayers,
): void {
  const order = graph.readingOrder ?? [];
  if (order.length === 0) return;
  const { nodeLayer, labelLayer } = layers;

  for (let i = 0; i < order.length; i++) {
    const mid = order[i];
    const ml = layout.methods[mid];
    if (!ml) continue;

    const cx = ml.pillL - 14;
    const cy = ml.cy;
    const badge = new Graphics();
    badge
      .circle(cx, cy, 9)
      .fill({ color: READING_ORDER_FILL, alpha: 0.95 })
      .stroke({ color: READING_ORDER_BORDER, width: 1.2, alpha: 0.9 });
    nodeLayer.addChild(badge);

    const text = String(i + 1);
    const t = new Text({
      text,
      style: {
        fill: READING_ORDER_TEXT,
        fontSize: 10,
        fontWeight: '600',
        fontFamily: MONO_FONT,
      },
    });
    t.x = cx - t.width / 2;
    t.y = cy - t.height / 2;
    labelLayer.addChild(t);
  }
}

/**
 * Build a verification overlay rectangle: solid green/amber for
 * verified/partial, dashed red for unverified. Returns null when no
 * overlay is needed (defensive — currently all three states return one).
 */
function buildVerificationOverlay(
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  state: 'verified' | 'partial' | 'unverified',
): Graphics | null {
  const overlay = new Graphics();
  if (state === 'verified') {
    overlay
      .roundRect(x - 1, y - 1, w + 2, h + 2, radius + 1)
      .stroke({ color: VERIFIED, width: 1.4, alpha: 0.7 });
    return overlay;
  }
  if (state === 'partial') {
    overlay
      .roundRect(x - 1, y - 1, w + 2, h + 2, radius + 1)
      .stroke({ color: PARTIAL, width: 1.6, alpha: 0.9 });
    return overlay;
  }
  drawDashedRect(overlay, x - 1, y - 1, w + 2, h + 2, 6, 4);
  overlay.stroke({ color: UNVERIFIED, width: 1.6, alpha: 0.95 });
  return overlay;
}

/**
 * Draw method pills + entry triangle + partial amber border, and
 * back-fill pillL/R/Cx/Cy on each `MethodLayout` so edge routing can use them.
 */
export function renderMethodPills(
  layout: LaneLayout,
  graph: CodeMapGraph,
  layers: NodeLayers,
): Map<string, NodeGroup> {
  const { nodeLayer, labelLayer } = layers;
  const entryIds = new Set(graph.entryMethodIds);
  const byId = new Map<string, NodeGroup>();

  for (const ml of Object.values(layout.methods)) {
    const m = graph.methods[ml.id];
    const isEntry = entryIds.has(ml.id);
    const rawName = m ? m.name : (graph.externalDeps[ml.id]?.name ?? ml.id);
    const textStr = m ? `+ ${rawName}()` : rawName;
    const group: NodeGroup = [];

    // Stub methods (class-id fallback target with no MethodNode) are
    // treated as unverified. ext: targets don't have a verification state
    // — we leave their pill border neutral via the 'verified' branch.
    const verification: 'verified' | 'partial' | 'unverified' =
      m?.verification ?? (graph.externalDeps[ml.id] ? 'verified' : 'unverified');

    const label = new Text({
      text: textStr,
      style: { fill: TEXT_PRIMARY, fontSize: 11, fontWeight: '400', fontFamily: MONO_FONT },
    });

    // Force layout gives a node centre (ml.cx/cy); the pill is label-driven
    // and centred on it. No column clamp — cards are framed around pills.
    const entryLeadPad = isEntry ? 10 : 0;
    const pillW = label.width + 2 * PILL_HPAD + entryLeadPad;
    const pillX = ml.cx - pillW / 2;
    const pillY = ml.cy - PILL_H / 2;

    const pill = new Graphics();
    const pillBorder = pillBorderFor(verification);
    if (verification === 'unverified') {
      pill
        .roundRect(pillX, pillY, pillW, PILL_H, PILL_H / 2)
        .fill({ color: PILL_FILL, alpha: 1 });
      drawDashedRect(pill, pillX, pillY, pillW, PILL_H, 4, 3);
      pill.stroke({ color: pillBorder.color, width: pillBorder.width, alpha: 1 });
    } else {
      pill
        .roundRect(pillX, pillY, pillW, PILL_H, PILL_H / 2)
        .fill({ color: PILL_FILL, alpha: 1 })
        .stroke({ color: pillBorder.color, width: pillBorder.width, alpha: 1 });
    }
    nodeLayer.addChild(pill);
    group.push(pill);

    if (isEntry) {
      const triX = pillX + 6;
      const tri = new Graphics();
      tri
        .moveTo(triX, ml.cy - 5)
        .lineTo(triX, ml.cy + 5)
        .lineTo(triX + 8, ml.cy)
        .closePath()
        .fill({ color: ENTRY_RING, alpha: 1 });
      nodeLayer.addChild(tri);
      group.push(tri);
    }

    label.x = pillX + PILL_HPAD + entryLeadPad;
    label.y = ml.cy - label.height / 2;
    labelLayer.addChild(label);
    group.push(label);

    fillPillBounds(ml, pillX, pillW);
    byId.set(ml.id, group);
  }

  return byId;
}

function fillPillBounds(ml: MethodLayout, pillX: number, pillW: number): void {
  ml.pillL = pillX;
  ml.pillR = pillX + pillW;
  ml.pillCx = pillX + pillW / 2;
  ml.pillCy = ml.cy;
}

function pillBorderFor(state: 'verified' | 'partial' | 'unverified'): { color: number; width: number } {
  if (state === 'partial') return { color: PARTIAL, width: 2 };
  if (state === 'unverified') return { color: UNVERIFIED, width: 1.6 };
  return { color: VERIFIED, width: 1.2 };
}

/**
 * Approximate a dashed rectangle with straight-segment dashes along the
 * four sides; corner radius is ignored so dashes stay visually crisp on
 * the short sides (pills are ~22px tall). Caller is expected to call
 * `stroke()` afterwards.
 */
function drawDashedRect(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  dashLen: number,
  gapLen: number,
): void {
  const sides: [number, number, number, number][] = [
    [x, y, x + w, y],
    [x + w, y, x + w, y + h],
    [x + w, y + h, x, y + h],
    [x, y + h, x, y],
  ];
  for (const [ax, ay, bx, by] of sides) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    let pos = 0;
    while (pos < len) {
      const end = Math.min(pos + dashLen, len);
      g.moveTo(ax + ux * pos, ay + uy * pos).lineTo(ax + ux * end, ay + uy * end);
      pos = end + gapLen;
    }
  }
}
