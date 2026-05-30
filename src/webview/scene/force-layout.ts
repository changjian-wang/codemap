// Pure d3-force layout — no Pixi, no DOM. Testable in isolation.
//
// Phase 1.2 replaces the hand-written column packer with a force simulation:
//   - every MethodNode (and every ext / stub card) becomes a sim node;
//   - same-class methods get a strong intra-class link so they cluster into
//     a swimlane card;
//   - each bounded context owns a vertical band (an `forceX` target), so
//     `capture` / `recall` / `shared` / `ext` stay chromatically AND spatially
//     distinct (ADR-005 §7.1 lesson 2);
//   - methodEdges add weak inter-node links so callers drift toward callees.
//
// The simulation is run to completion synchronously (no animation) and the
// settled coordinates are frozen into a `LaneLayout`, so the rest of the scene
// pipeline (node-renderer back-fills pill bounds, edge-routing reads them)
// is unchanged.

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
  CARD_PAD,
  PILL_H,
  PAD,
} from './lane-layout';

// Tunables — kept in one block so the HITL visual pass can iterate quickly.
const BAND_W = 320; // horizontal width allotted to each BC band
const NODE_SPACING = 64; // collision radius driver between method nodes
const INTRA_CLASS_STRENGTH = 0.9; // same-class methods clamp together
const INTER_EDGE_STRENGTH = 0.06; // caller→callee weak pull
const CHARGE = -480; // node repulsion
const BAND_X_STRENGTH = 0.18; // how hard a node is pulled to its BC band centre
const Y_GRAVITY = 0.04; // gentle vertical centring
const SETTLE_TICKS = 400; // synchronous run length
const LANE_PAD = 36; // padding around a swimlane's node bbox

interface SimNode extends SimulationNodeDatum {
  id: string;
  classId: string;
  bc: string;
  bandX: number;
  /** ext / stub cards have no methods; they render as a single node. */
  isCard: boolean;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  strength: number;
}

interface NodeBucket {
  /** Real class cards keyed by classId → contained method node ids. */
  classes: Record<string, ClassLayout>;
  /** Every sim node (methods + ext/stub cards). */
  nodes: SimNode[];
}

/**
 * Build the force input from the graph: one sim node per method, one per
 * ext dep, one per unresolved stub target. Returns the class scaffolding so
 * the caller can frame swimlane cards once positions settle.
 */
function buildNodes(graph: CodeMapGraph, bandOf: (bc: string) => number): NodeBucket {
  const classes: Record<string, ClassLayout> = {};
  const nodes: SimNode[] = [];

  for (const c of Object.values(graph.classes)) {
    const bc = graph.boundedContexts.includes(c.boundedContext)
      ? c.boundedContext
      : 'shared';
    classes[c.id] = {
      id: c.id,
      name: c.id,
      kind: 'real',
      bc,
      x: 0, y: 0, w: 0, h: 0,
      classNode: c,
      methodIds: c.methodIds,
      isEntry: !!c.isEntry,
      verification: c.verification,
    };
    for (const mid of c.methodIds) {
      nodes.push({ id: mid, classId: c.id, bc, bandX: bandOf(bc), isCard: false });
    }
  }

  for (const dep of Object.values(graph.externalDeps)) {
    classes[dep.id] = {
      id: dep.id,
      name: dep.name,
      kind: 'ext',
      bc: 'ext',
      x: 0, y: 0, w: 0, h: 0,
      classNode: null,
      methodIds: [],
      isEntry: false,
      verification: null,
    };
    nodes.push({ id: dep.id, classId: dep.id, bc: 'ext', bandX: bandOf('ext'), isCard: true });
  }

  // Class-id fallback: an edge target that is neither method, ext, nor real
  // class becomes an italic stub card in the ext band.
  const referenced = new Set<string>();
  for (const e of graph.methodEdges) referenced.add(e.target);
  for (const t of referenced) {
    if (graph.methods[t] || graph.externalDeps[t] || graph.classes[t]) continue;
    classes[t] = {
      id: t,
      name: t,
      kind: 'stub',
      bc: 'ext',
      x: 0, y: 0, w: 0, h: 0,
      classNode: null,
      methodIds: [],
      isEntry: false,
      verification: null,
    };
    nodes.push({ id: t, classId: t, bc: 'ext', bandX: bandOf('ext'), isCard: true });
  }

  return { classes, nodes };
}

/** Intra-class (strong) + inter-edge (weak) links between sim nodes. */
function buildLinks(graph: CodeMapGraph, ids: Set<string>): SimLink[] {
  const links: SimLink[] = [];

  // Same-class methods chained so the cluster stays tight.
  for (const c of Object.values(graph.classes)) {
    const ms = c.methodIds.filter((m) => ids.has(m));
    for (let i = 1; i < ms.length; i++) {
      links.push({ source: ms[i - 1], target: ms[i], strength: INTRA_CLASS_STRENGTH });
    }
  }

  // Caller → callee weak pull, only when both endpoints are sim nodes.
  for (const e of graph.methodEdges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    if (e.source === e.target) continue;
    links.push({ source: e.source, target: e.target, strength: INTER_EDGE_STRENGTH });
  }

  return links;
}

/**
 * Run the simulation to a settled state and project it into a `LaneLayout`.
 * `screenW` only seeds the initial band centring; the final bbox drives
 * fit-to-screen downstream.
 */
export function computeForceLayout(graph: CodeMapGraph, screenW: number): LaneLayout {
  const bcs = [...graph.boundedContexts, 'ext'];
  const presentBcs = new Set<string>();
  for (const c of Object.values(graph.classes)) {
    presentBcs.add(graph.boundedContexts.includes(c.boundedContext) ? c.boundedContext : 'shared');
  }
  if (Object.keys(graph.externalDeps).length > 0) presentBcs.add('ext');
  for (const e of graph.methodEdges) {
    if (!graph.methods[e.target] && !graph.externalDeps[e.target] && !graph.classes[e.target]) {
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

  // Seed positions near the band centre so the sim converges quickly and
  // deterministically (no random jitter — repeatable layout per fixture).
  nodes.forEach((n, i) => {
    n.x = n.bandX + ((i % 5) - 2) * 8;
    n.y = PAD.top + (i % 7) * NODE_SPACING;
  });

  const sim: Simulation<SimNode, SimLink> = forceSimulation(nodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance((l) => (l.strength >= INTRA_CLASS_STRENGTH ? NODE_SPACING : NODE_SPACING * 3))
        .strength((l) => l.strength),
    )
    .force('charge', forceManyBody<SimNode>().strength(CHARGE))
    .force('bandX', forceX<SimNode>((d) => d.bandX).strength(BAND_X_STRENGTH))
    .force('gravityY', forceY<SimNode>(PAD.top + 200).strength(Y_GRAVITY))
    .force('collide', forceCollide<SimNode>(NODE_SPACING / 2))
    .stop();

  for (let i = 0; i < SETTLE_TICKS; i++) sim.tick();

  return projectLayout(classes, nodes, visibleBcs, bandW);
}

/** Freeze settled node coords into class cards, method pills, and swimlanes. */
function projectLayout(
  classes: Record<string, ClassLayout>,
  nodes: SimNode[],
  visibleBcs: string[],
  bandW: number,
): LaneLayout {
  const posById = new Map<string, { x: number; y: number }>();
  for (const n of nodes) posById.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });

  const methods: Record<string, MethodLayout> = {};
  for (const n of nodes) {
    if (n.isCard) continue;
    const p = posById.get(n.id)!;
    methods[n.id] = {
      id: n.id,
      classId: n.classId,
      bc: n.bc,
      cx: p.x,
      cy: p.y,
      pillL: 0, pillR: 0, pillCx: 0, pillCy: 0,
    };
  }

  // Frame each real class card around the bbox of its method nodes.
  for (const cl of Object.values(classes)) {
    if (cl.kind === 'real' && cl.methodIds.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const mid of cl.methodIds) {
        const p = posById.get(mid);
        if (!p) continue;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      cl.x = minX - CARD_PAD - 12;
      cl.y = minY - HEADER_H - PILL_H / 2 - 4;
      cl.w = maxX - minX + 2 * (CARD_PAD + 12) + 160;
      cl.h = maxY - minY + HEADER_H + PILL_H + 2 * CARD_PAD;
    } else {
      // ext / stub: a single-node card framed on its own position.
      const p = posById.get(cl.id) ?? { x: 0, y: 0 };
      cl.x = p.x - CARD_PAD;
      cl.y = p.y - HEADER_H / 2 - CARD_PAD;
      cl.w = 200;
      cl.h = HEADER_H + METHOD_H + CARD_PAD;
    }
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
