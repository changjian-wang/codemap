import { Container, Graphics, Text } from 'pixi.js';
import type { CodeMapGraph } from '../../shared/types';
import {
  type LaneLayout,
  type MethodLayout,
  CARD_PAD,
  PILL_H,
  PILL_HPAD,
} from './lane-layout';

// VS-Code-dark palette, kept in sync with the R1 spike.
const BC_COLORS: Record<string, number> = {
  capture: 0x4ec9b0,
  recall: 0xc586c0,
  shared: 0x569cd6,
};
const EXT_COLOR = 0xdcdcaa;
const STUB_COLOR = 0x858585;
const ENTRY_RING = 0xf59e0b;
const PARTIAL = 0xf59e0b;
const PILL_FILL = 0x252526;
const PILL_BORDER = 0xc0c8d2;
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

export function renderClassCards(layout: LaneLayout, layers: NodeLayers): void {
  const { bgLayer, nodeLayer, labelLayer } = layers;
  for (const cl of Object.values(layout.classes)) {
    const color = bcColor(cl.bc);
    const isStub = cl.kind === 'stub';

    const card = new Graphics();
    card
      .roundRect(cl.x, cl.y, cl.w, cl.h, 12)
      .fill({ color: PAGE_BG, alpha: 1 })
      .stroke({ color, width: 2, alpha: isStub ? 0.5 : 1 });
    bgLayer.addChild(card);

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

    if (cl.isEntry) {
      const badge = new Graphics();
      badge.circle(cl.x + cl.w - 14, cl.y + 14, 5).fill(ENTRY_RING);
      nodeLayer.addChild(badge);
    }

    if (cl.verification === 'partial') {
      const overlay = new Graphics();
      overlay
        .roundRect(cl.x - 1, cl.y - 1, cl.w + 2, cl.h + 2, 13)
        .stroke({ color: PARTIAL, width: 1.5, alpha: 0.85 });
      bgLayer.addChild(overlay);
    }
  }
}

/**
 * Draw method pills + entry triangle + partial amber border, and
 * back-fill pillL/R/Cx/Cy on each `MethodLayout` so edge routing can use them.
 */
export function renderMethodPills(
  layout: LaneLayout,
  graph: CodeMapGraph,
  layers: NodeLayers,
): void {
  const { nodeLayer, labelLayer } = layers;
  const entryIds = new Set(graph.entryMethodIds);

  for (const ml of Object.values(layout.methods)) {
    const m = graph.methods[ml.id];
    const isPartial = m?.verification === 'partial';
    const isEntry = entryIds.has(ml.id);
    const rawName = m ? m.name : (graph.externalDeps[ml.id]?.name ?? ml.id);
    const textStr = m ? `+ ${rawName}()` : rawName;

    const pillBorder = isPartial ? PARTIAL : PILL_BORDER;
    const pillBorderW = isPartial ? 2 : 1;

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
    pill
      .roundRect(pillX, pillY, pillW, PILL_H, PILL_H / 2)
      .fill({ color: PILL_FILL, alpha: 1 })
      .stroke({ color: pillBorder, width: pillBorderW, alpha: 1 });
    nodeLayer.addChild(pill);

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
    }

    label.x = pillX + PILL_HPAD + entryLeadPad;
    label.y = ml.cy - label.height / 2;
    labelLayer.addChild(label);

    fillPillBounds(ml, pillX, pillW);
  }
}

function fillPillBounds(ml: MethodLayout, pillX: number, pillW: number): void {
  ml.pillL = pillX;
  ml.pillR = pillX + pillW;
  ml.pillCx = pillX + pillW / 2;
  ml.pillCy = ml.cy;
}
