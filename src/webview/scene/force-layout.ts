// Pure d3-force layout — no Pixi, no DOM. Testable in isolation.
//
// Phase 1.2 placed every METHOD as a sim node, which produced beautiful
// mini-graphs on the 5-class lumen fixture but collapsed under 30+ real
// classes (edges everywhere, cards overlapping, no navigation).
//
// "ALL mode" rewrite (post Phase 3.4 HITL): every CLASS is one sim node.
// Cards are pre-sized from class name length + method-count badge, so the
// collision radius is correct from tick 0. Inter-class pull comes from
// graph.classEdges (already collapsed via aggregator). Methods are not
// part of this view -- use the /focus chat command for a method-level
// subgraph.

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceX,
  forceY,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { CodeMapGraph } from '../../shared/types';
import {
  type ClassLayout,
  type MethodLayout,
  type LaneLayout,
  type Swimlane,
  HEADER_H,
  METHOD_H,
  PAD,
} from './lane-layout';

// Tunables -- HITL visual pass iterates here.
const BAND_W = 280;
const CARD_GAP = 24;            // collision spacing between cards (added to each card's half-extent)
const INTER_EDGE_STRENGTH = 0.05;
const CHARGE = -360;
const BAND_X_STRENGTH = 0.20;
const Y_GRAVITY = 0.03;
const SETTLE_TICKS = 350;
const LANE_PAD = 36;

// Card sizing for ALL-collapsed mode. The card shows the header (class
// name + entry badge) and a small "N methods" subtitle when applicable.
const CARD_W_MIN = 160;
const CARD_W_PER_CHAR = 8.5;
const CARD_W_PAD = 56;
const CARD_W_MAX = 360;
const CARD_H_HEADER_ONLY = HEADER_H + 14;     // class card with no methods
const CARD_H_WITH_BADGE = HEADER_H + 26;      // class card with N-methods subtitle
const CARD_H_EXT = METHOD_H + 14;             // ext / stub cards

interface SimNode extends SimulationNodeDatum {
  id: string;
  bc: string;
  bandX: number;
  /** Half-width + CARD_GAP, used by forceCollide. */
  radius: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  strength: number;
}

interface NodeBucket {
  classes: Record<string, ClassLayout>;
  nodes: SimNode[];
}

function measureCardWidth(name: string): number {
  return Math.max(
    CARD_W_MIN,
    Math.min(CARD_W_MAX, Math.round(name.length * CARD_W_PER_CHAR + CARD_W_PAD)),
  );
}

function buildNodes(graph: CodeMapGraph, bandOf: (bc: string) => number): NodeBucket {
  const classes: Record<string, ClassLayout> = {};
  const nodes: SimNode[] = [];

  for (const c of Object.values(graph.classes)) {
    const bc = graph.boundedContexts.includes(c.boundedContext)
      ? c.boundedContext
      : 'shared';
    const w = measureCardWidth(c.id);
    const h = c.methodIds.length > 0 ? CARD_H_WITH_BADGE : CARD_H_HEADER_ONLY;
    classes[c.id] = {
      id: c.id,
      name: c.id,
      kind: 'real',
      bc,
      x: 0, y: 0, w, h,
      classNode: c,
      methodIds: c.methodIds,
      isEntry: !!c.isEntry,
      verification: c.verification,
    };
    nodes.push({
      id: c.id, bc, bandX: bandOf(bc),
      radius: Math.max(w, h) / 2 + CARD_GAP,
    });
  }

  for (const dep of Object.values(graph.externalDeps)) {
    const w = measureCardWidth(dep.name);
    classes[dep.id] = {
      id: dep.id,
      name: dep.name,
      kind: 'ext',
      bc: 'ext',
      x: 0, y: 0, w, h: CARD_H_EXT,
      classNode: null,
      methodIds: [],
      isEntry: false,
      verification: null,
    };
    nodes.push({
      id: dep.id, bc: 'ext', bandX: bandOf('ext'),
      radius: Math.max(w, CARD_H_EXT) / 2 + CARD_GAP,
    });
  }

  // Class-id fallback: an edge target that is neither method, ext, nor real
  // class becomes a stub card in the ext band.
  const referenced = new Set<string>();
  for (const e of graph.methodEdges) referenced.add(e.target);
  for (const e of graph.classEdges) referenced.add(e.target);
  for (const t of referenced) {
    if (graph.methods[t] || graph.externalDeps[t] || graph.classes[t]) continue;
    const w = measureCardWidth(t);
    classes[t] = {
      id: t,
      name: t,
      kind: 'stub',
      bc: 'ext',
      x: 0, y: 0, w, h: CARD_H_EXT,
      classNode: null,
      methodIds: [],
      isEntry: false,
      verification: null,
    };
    nodes.push({
      id: t, bc: 'ext', bandX: bandOf('ext'),
      radius: Math.max(w, CARD_H_EXT) / 2 + CARD_GAP,
    });
  }

  return { classes, nodes };
}

function buildLinks(graph: CodeMapGraph, ids: Set<string>): SimLink[] {
  const links: SimLink[] = [];
  for (const e of graph.classEdges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    if (e.source === e.target) continue;
    links.push({ source: e.source, target: e.target, strength: INTER_EDGE_STRENGTH });
  }
  return links;
}

/**
 * Run the simulation to a settled state and project it into a `LaneLayout`.
 */
export function computeForceLayout(graph: CodeMapGraph, screenW: number): LaneLayout {
  const bcs = [...graph.boundedContexts, 'ext'];
  const presentBcs = new Set<string>();
  for (const c of Object.values(graph.classes)) {
    presentBcs.add(graph.boundedContexts.includes(c.boundedContext) ? c.boundedContext : 'shared');
  }
  if (Object.keys(graph.externalDeps).length > 0) presentBcs.add('ext');
  for (const e of graph.classEdges) {
    if (!graph.externalDeps[e.target] && !graph.classes[e.target]) {
      presentBcs.add('ext');
    }
  }
  const visibleBcs = bcs.filter((b) => presentBcs.has(b));

  const bandIndex = new Map(visibleBcs.map((b, i) => [b, i]));
  const totalW = Math.max(BAND_W * visibleBcs.length, screenW - PAD.left - PAD.right);
  const bandW = totalW / Math.max(1, visibleBcs.length);
  const bandOf = (bc: string): number => {
    const i = bandIndex.get(bc) ?? 0;
    return PAD.left + bandW * (i + 0.5);
  };

  const { classes, nodes } = buildNodes(graph, bandOf);
  const ids = new Set(nodes.map((n) => n.id));
  const links = buildLinks(graph, ids);

  // Deterministic seed so the layout is repeatable per fixture.
  nodes.forEach((n, i) => {
    n.x = n.bandX + ((i % 5) - 2) * 12;
    n.y = PAD.top + (i % 9) * 80;
  });

  const sim: Simulation<SimNode, SimLink> = forceSimulation(nodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance(220)
        .strength((l) => l.strength),
    )
    .force('charge', forceManyBody<SimNode>().strength(CHARGE))
    .force('bandX', forceX<SimNode>((d) => d.bandX).strength(BAND_X_STRENGTH))
    .force('gravityY', forceY<SimNode>(PAD.top + 200).strength(Y_GRAVITY))
    .force('collide', forceCollide<SimNode>((d) => d.radius))
    .stop();

  for (let i = 0; i < SETTLE_TICKS; i++) sim.tick();

  const layout = projectLayout(classes, nodes, visibleBcs, bandW);
  packBands(layout);
  return layout;
}

// Tunables for the post-projection packer (Phase 3.4 dispose-hang fix sibling
// commit -- real workspaces have 30+ classes and the raw force layout
// produces cards that overlap when many classes have 0-1 methods all pulled
// to the same Y by forceY gravity).
const PACK_GAP_Y = 28;
const PACK_GAP_X = 28;
const PACK_BAND_GAP_X = 64;
const PACK_TOP_PAD = 16;
const PACK_TARGET_ASPECT = 1.4; // band aspect ratio (w / h) target -> wider bands prefer more columns

/**
 * Deterministic post-projection packer. The force sim positions METHOD
 * points and forceCollide only spaces those points by ~32px, so class
 * CARDS framed around small / single-method method sets end up overlapping
 * each other within a BC band. This pass:
 *   1. Decides a column count per band so the band aspect (w/h) stays
 *      readable. A single column for 37 classes produces a vertical strip
 *      taller than the viewport; ceil(sqrt(n)) gives a roughly square
 *      grid that pans on standard displays.
 *   2. Sorts cards by their force-derived Y (preserves caller -> callee
 *      top-down hint) and grids them column-major: card[0..rows-1] in
 *      column 0, card[rows..2*rows-1] in column 1, etc. Each column's
 *      width = max card width in that column; rows in the same column
 *      stack with PACK_GAP_Y.
 *   3. Bands lay out left-to-right with PACK_BAND_GAP_X between them.
 *   4. Shifts each card and its contained method pills by the same delta
 *      so edge routing reads the new positions unchanged.
 *   5. Rebuilds swimlanes + bbox from the packed cards.
 *
 * The cost: caller -> callee X-alignment is approximate. The benefit:
 * 30+ class workspaces render in a navigable rectangle instead of a
 * 6000px tall column.
 */
function packBands(layout: LaneLayout): void {
  const allCards = Object.values(layout.classes);
  if (allCards.length === 0) return;

  let bandLeftX = PAD.left + LANE_PAD;

  for (const bc of layout.visibleBcs) {
    const cardsInBand = allCards
      .filter((c) => c.bc === bc)
      .sort((a, b) => a.y - b.y);
    if (cardsInBand.length === 0) continue;

    const cols = chooseColumnCount(cardsInBand);
    const rows = Math.ceil(cardsInBand.length / cols);

    // Slice into columns (column-major, so caller -> callee Y order is
    // preserved within each column).
    const columns: ClassLayout[][] = [];
    for (let i = 0; i < cols; i++) {
      columns.push(cardsInBand.slice(i * rows, (i + 1) * rows));
    }

    // Per-column width = max card width in that column.
    const colWidths = columns.map((col) =>
      col.length === 0 ? 0 : Math.max(...col.map((c) => c.w)),
    );

    // Lay out each column.
    let cursorX = bandLeftX;
    for (let ci = 0; ci < columns.length; ci++) {
      const col = columns[ci]!;
      const colW = colWidths[ci]!;
      const colCenter = cursorX + colW / 2;
      let cursorY = PAD.top + PACK_TOP_PAD;
      for (const card of col) {
        const newX = colCenter - card.w / 2;
        const dx = newX - card.x;
        const dy = cursorY - card.y;
        card.x = newX;
        card.y = cursorY;
        for (const mid of card.methodIds) {
          const m = layout.methods[mid];
          if (!m) continue;
          m.cx += dx;
          m.cy += dy;
        }
        cursorY = card.y + card.h + PACK_GAP_Y;
      }
      cursorX += colW + PACK_GAP_X;
    }

    // Advance to next band; pull back the last column gap and add the
    // larger band gap.
    bandLeftX = cursorX - PACK_GAP_X + PACK_BAND_GAP_X;
  }

  // 5. Rebuild swimlanes + bbox from the packed cards.
  layout.swimlanes = buildSwimlanes(layout.classes, layout.visibleBcs);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const lane of layout.swimlanes) {
    minX = Math.min(minX, lane.x);
    minY = Math.min(minY, lane.y);
    maxX = Math.max(maxX, lane.x + lane.w);
    maxY = Math.max(maxY, lane.y + lane.h);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
  minY = Math.min(minY, PAD.top - 50);
  layout.bbox = { minX, minY, maxX, maxY };
}

function chooseColumnCount(cards: readonly ClassLayout[]): number {
  if (cards.length <= 4) return 1;
  // Estimate average card aspect from this band to pick cols so the band
  // aspect ratio lands near PACK_TARGET_ASPECT.
  let totalW = 0;
  let totalH = 0;
  for (const c of cards) {
    totalW += c.w;
    totalH += c.h + PACK_GAP_Y;
  }
  const avgW = totalW / cards.length;
  const avgH = totalH / cards.length;
  // For c columns, band width ~ c * (avgW + PACK_GAP_X), band height ~
  // ceil(n/c) * avgH. Solve c * (avgW + gap) / (n/c * avgH) ~= aspect.
  const ideal = Math.sqrt(
    (cards.length * avgH * PACK_TARGET_ASPECT) / (avgW + PACK_GAP_X),
  );
  return Math.max(1, Math.min(cards.length, Math.round(ideal)));
}

/** Freeze settled node coords into class cards. methods stays empty in
 *  ALL-collapsed mode. */
function projectLayout(
  classes: Record<string, ClassLayout>,
  nodes: SimNode[],
  visibleBcs: string[],
  bandW: number,
): LaneLayout {
  const methods: Record<string, MethodLayout> = {};

  // Each SimNode IS a class card; center the pre-sized card on the
  // settled (x, y).
  for (const n of nodes) {
    const cl = classes[n.id];
    if (!cl) continue;
    const cx = n.x ?? 0;
    const cy = n.y ?? 0;
    cl.x = cx - cl.w / 2;
    cl.y = cy - cl.h / 2;
  }

  const swimlanes = buildSwimlanes(classes, visibleBcs);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const lane of swimlanes) {
    minX = Math.min(minX, lane.x);
    minY = Math.min(minY, lane.y);
    maxX = Math.max(maxX, lane.x + lane.w);
    maxY = Math.max(maxY, lane.y + lane.h);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
  minY = Math.min(minY, PAD.top - 50);

  return { classes, methods, swimlanes, visibleBcs, colW: bandW, bbox: { minX, minY, maxX, maxY } };
}

/** One backdrop band per BC, framed around every card in that BC. */
function buildSwimlanes(
  classes: Record<string, ClassLayout>,
  visibleBcs: string[],
): Swimlane[] {
  const lanes: Swimlane[] = [];
  for (const bc of visibleBcs) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const cl of Object.values(classes)) {
      if (cl.bc !== bc) continue;
      minX = Math.min(minX, cl.x);
      minY = Math.min(minY, cl.y);
      maxX = Math.max(maxX, cl.x + cl.w);
      maxY = Math.max(maxY, cl.y + cl.h);
    }
    if (!isFinite(minX)) continue;
    lanes.push({
      bc,
      x: minX - LANE_PAD,
      y: minY - LANE_PAD - 28,
      w: maxX - minX + 2 * LANE_PAD,
      h: maxY - minY + 2 * LANE_PAD + 28,
    });
  }
  return lanes;
}
