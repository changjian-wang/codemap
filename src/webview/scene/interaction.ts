// Hover / focus / pan / zoom for the Pixi scene.
//
// Hit-test priority (top-down): method pill > ext|stub card > edge bezier.
// Focus state is a single pinned methodId (or null). When pinned, every
// non-neighbour method / class / edge is dimmed via per-group alpha. Hover
// is independent: it only paints the hover-edge overlay and the tooltip.

import type { Application, Container, Graphics } from 'pixi.js';
import { Graphics as PixiGraphics } from 'pixi.js';
import type { CodeMapGraph, MethodEdge } from '../../shared/types';
import { type LaneLayout, PILL_H } from './lane-layout';
import { type Router, bezierPt } from './edge-routing';
import type { NodeGroup } from './node-renderer';

const HOVER_EDGE_PX = 12;            // pixel hit slop on a bezier
const FOCUS_DIM_ALPHA = 0.25;        // dim multiplier for nodes off-focus
const FOCUS_EDGE_DIM_ALPHA = 0.15;   // dim multiplier for edges off-focus
const HOVER_EDGE_COLOR = 0xfbbf24;   // amber accent for hover / focus edges

export interface SceneHandles {
  app: Application;
  root: Container;
  edgeLayer: Container;
  layout: LaneLayout;
  graph: CodeMapGraph;
  router: Router;
  methodPills: Map<string, NodeGroup>;
  cards: Map<string, NodeGroup>;
  edges: Map<string, Graphics>;
  tooltip: HTMLElement;
  onRequestOpenReference: (target: string, sources: string[]) => void;
  fitToScreen: () => ViewState;
}

export interface ViewState {
  x: number;
  y: number;
  sx: number;
  sy: number;
}

/**
 * Wire pointer events, focus state, hover overlay, and tooltip. Returns
 * nothing — interaction state is internal; the caller only re-invokes
 * `fitToScreen` / `installInteraction` if it rebuilds the scene.
 */
export function installInteraction(h: SceneHandles): void {
  const canvas = h.app.canvas;

  // Hover overlay sits above edgesG so the highlighted curve paints over the
  // base stroke. One Graphics, cleared & redrawn on every state change.
  const hoverG = new PixiGraphics();
  h.edgeLayer.addChild(hoverG);

  // Incoming / outgoing edge index, keyed by method id, for fast neighbour
  // / hover lookups. ext targets count as outgoing-only neighbours.
  const outgoing = new Map<string, MethodEdge[]>();
  const incoming = new Map<string, MethodEdge[]>();
  for (const e of h.graph.methodEdges) {
    push(outgoing, e.source, e);
    push(incoming, e.target, e);
  }

  let initial = h.fitToScreen();
  let pinned: string | null = null;
  let hoverMethod: string | null = null;
  let hoverEdge: string | null = null;
  let hoverCard: string | null = null;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let dragMoved = false;

  function applyFocus(): void {
    if (pinned === null) {
      for (const g of h.methodPills.values()) setAlpha(g, 1);
      for (const g of h.cards.values()) setAlpha(g, 1);
      for (const g of h.edges.values()) g.alpha = 1;
      redrawHover();
      return;
    }
    const neighbourMethods = methodNeighbours(pinned);
    const neighbourClasses = classNeighbours(neighbourMethods);
    for (const [id, group] of h.methodPills) {
      setAlpha(group, neighbourMethods.has(id) ? 1 : FOCUS_DIM_ALPHA);
    }
    for (const [id, group] of h.cards) {
      setAlpha(group, neighbourClasses.has(id) ? 1 : FOCUS_DIM_ALPHA);
    }
    for (const [id, g] of h.edges) {
      g.alpha = isFocusEdge(id, neighbourMethods) ? 1 : FOCUS_EDGE_DIM_ALPHA;
    }
    redrawHover();
  }

  function methodNeighbours(mid: string): Set<string> {
    const s = new Set<string>([mid]);
    for (const e of outgoing.get(mid) ?? []) s.add(e.target);
    for (const e of incoming.get(mid) ?? []) s.add(e.source);
    // Sibling methods on the same class are visually part of the focus.
    const cls = h.layout.methods[mid]?.classId;
    if (cls) {
      const c = h.graph.classes[cls];
      if (c) for (const sib of c.methodIds) s.add(sib);
    }
    return s;
  }

  function classNeighbours(methodIds: Set<string>): Set<string> {
    const s = new Set<string>();
    for (const mid of methodIds) {
      const ml = h.layout.methods[mid];
      if (ml) s.add(ml.classId);
      // ext / stub targets are id-equal to a card id when no method exists.
      if (h.cards.has(mid)) s.add(mid);
    }
    return s;
  }

  function isFocusEdge(edgeId: string, neighbourMethods: Set<string>): boolean {
    const e = edgeById.get(edgeId);
    if (!e) return false;
    return neighbourMethods.has(e.source) || neighbourMethods.has(e.target) || e.source === pinned || e.target === pinned;
  }
  const edgeById = new Map(h.graph.methodEdges.map((e) => [e.id, e]));

  function redrawHover(): void {
    hoverG.clear();
    const edgesToPaint = new Set<string>();
    if (hoverEdge) edgesToPaint.add(hoverEdge);
    if (hoverMethod) {
      for (const e of outgoing.get(hoverMethod) ?? []) edgesToPaint.add(e.id);
      for (const e of incoming.get(hoverMethod) ?? []) edgesToPaint.add(e.id);
    }
    if (pinned) {
      for (const e of outgoing.get(pinned) ?? []) edgesToPaint.add(e.id);
      for (const e of incoming.get(pinned) ?? []) edgesToPaint.add(e.id);
    }
    for (const id of edgesToPaint) {
      const e = edgeById.get(id);
      if (!e) continue;
      const bz = h.router.bezierForEdge(e);
      if (!bz) continue;
      hoverG
        .moveTo(bz.p0.x, bz.p0.y)
        .bezierCurveTo(bz.p1.x, bz.p1.y, bz.p2.x, bz.p2.y, bz.p3.x, bz.p3.y)
        .stroke({ color: HOVER_EDGE_COLOR, width: 2.5, alpha: 1 });
      hoverG.circle(bz.p0.x, bz.p0.y, 3.5).fill({ color: HOVER_EDGE_COLOR, alpha: 0.95 });
      hoverG.circle(bz.p3.x, bz.p3.y, 3.5).fill({ color: HOVER_EDGE_COLOR, alpha: 0.95 });
    }
  }

  function hitTest(mx: number, my: number): { kind: 'method' | 'card' | 'edge'; id: string } | null {
    // 1. Method pills: tight rect match.
    for (const ml of Object.values(h.layout.methods)) {
      if (
        mx >= ml.pillL && mx <= ml.pillR &&
        my >= ml.cy - PILL_H / 2 && my <= ml.cy + PILL_H / 2
      ) {
        return { kind: 'method', id: ml.id };
      }
    }
    // 2. Ext / stub cards (real cards are decorative; skipping them lets
    //    the user click "through" to nested pills without ambiguity).
    for (const cl of Object.values(h.layout.classes)) {
      if (cl.kind === 'real') continue;
      if (mx >= cl.x && mx <= cl.x + cl.w && my >= cl.y && my <= cl.y + cl.h) {
        return { kind: 'card', id: cl.id };
      }
    }
    // 3. Edge bezier sample within HOVER_EDGE_PX (in world units).
    const threshold = HOVER_EDGE_PX / h.root.scale.x;
    let bestId: string | null = null;
    let bestDist = threshold;
    for (const e of h.graph.methodEdges) {
      const bz = h.router.bezierForEdge(e);
      if (!bz) continue;
      let minD2 = Infinity;
      for (let i = 0; i <= 30; i++) {
        const pt = bezierPt(i / 30, bz.p0, bz.p1, bz.p2, bz.p3);
        const d2 = (pt.x - mx) * (pt.x - mx) + (pt.y - my) * (pt.y - my);
        if (d2 < minD2) minD2 = d2;
      }
      const d = Math.sqrt(minD2);
      if (d < bestDist) {
        bestDist = d;
        bestId = e.id;
      }
    }
    return bestId ? { kind: 'edge', id: bestId } : null;
  }

  function showTooltip(text: string, clientX: number, clientY: number): void {
    h.tooltip.textContent = text;
    h.tooltip.style.left = `${clientX + 14}px`;
    h.tooltip.style.top = `${clientY + 14}px`;
    h.tooltip.style.display = 'block';
  }
  function hideTooltip(): void {
    h.tooltip.style.display = 'none';
  }

  function tooltipFor(hit: { kind: 'method' | 'card' | 'edge'; id: string }): string {
    if (hit.kind === 'method') {
      const m = h.graph.methods[hit.id];
      if (!m) return hit.id;
      const cls = h.graph.classes[m.ownerClassId];
      const lines = [`${m.ownerClassId}.${m.name}${m.signature ?? '()'}`];
      if (m.intent) lines.push(m.intent);
      if (cls?.intent) lines.push(`[${cls.boundedContext}] ${cls.intent}`);
      if (m.risks && m.risks.length > 0) lines.push(`risks: ${m.risks.join(', ')}`);
      return lines.join('\n');
    }
    if (hit.kind === 'card') {
      const cl = h.layout.classes[hit.id];
      const dep = h.graph.externalDeps[hit.id];
      if (dep) return `${dep.name} (external ${dep.kind ?? 'dep'})\nclick to list call sites`;
      return `${cl?.name ?? hit.id} (unresolved)\nclass-id fallback — not in scope`;
    }
    const e = edgeById.get(hit.id);
    if (!e) return hit.id;
    const arrow = e.verified ? '→' : '⇢';
    const tag = e.kind === 'external_calls' ? ' [ext]' : '';
    return `${e.source} ${arrow} ${e.target}${tag}`;
  }

  function callSitesOf(target: string): string[] {
    return h.graph.methodEdges.filter((e) => e.target === target).map((e) => e.source);
  }

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = true;
    dragMoved = false;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
  });

  canvas.addEventListener('pointerup', (e: PointerEvent) => {
    canvas.releasePointerCapture?.(e.pointerId);
    const wasDragging = dragging;
    dragging = false;
    if (wasDragging && dragMoved) return; // pure pan, not a click

    const world = toWorld(e.clientX, e.clientY);
    const hit = hitTest(world.x, world.y);
    if (!hit) {
      if (pinned !== null) {
        pinned = null;
        applyFocus();
      }
      return;
    }
    if (hit.kind === 'method') {
      pinned = pinned === hit.id ? null : hit.id;
      applyFocus();
    } else if (hit.kind === 'card') {
      h.onRequestOpenReference(hit.id, callSitesOf(hit.id));
    } else {
      // Click on an edge: jump focus to the source method.
      const e2 = edgeById.get(hit.id);
      if (e2 && h.methodPills.has(e2.source)) {
        pinned = e2.source;
        applyFocus();
      }
    }
  });

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (dragging) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
      h.root.x += dx;
      h.root.y += dy;
      lastX = e.clientX;
      lastY = e.clientY;
      hideTooltip();
      return;
    }
    const world = toWorld(e.clientX, e.clientY);
    const hit = hitTest(world.x, world.y);
    const newMethod = hit?.kind === 'method' ? hit.id : null;
    const newEdge = hit?.kind === 'edge' ? hit.id : null;
    const newCard = hit?.kind === 'card' ? hit.id : null;
    if (newMethod !== hoverMethod || newEdge !== hoverEdge || newCard !== hoverCard) {
      hoverMethod = newMethod;
      hoverEdge = newEdge;
      hoverCard = newCard;
      redrawHover();
    }
    if (hit) {
      showTooltip(tooltipFor(hit), e.clientX, e.clientY);
      canvas.style.cursor = hit.kind === 'method' || hit.kind === 'card' ? 'pointer' : 'default';
    } else {
      hideTooltip();
      canvas.style.cursor = 'default';
    }
  });

  canvas.addEventListener('pointerleave', () => {
    hideTooltip();
    if (hoverMethod || hoverEdge || hoverCard) {
      hoverMethod = null;
      hoverEdge = null;
      hoverCard = null;
      redrawHover();
    }
  });

  canvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const wx = (e.clientX - h.root.x) / h.root.scale.x;
      const wy = (e.clientY - h.root.y) / h.root.scale.y;
      h.root.scale.x *= factor;
      h.root.scale.y *= factor;
      h.root.x = e.clientX - wx * h.root.scale.x;
      h.root.y = e.clientY - wy * h.root.scale.y;
    },
    { passive: false },
  );

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'r' || e.key === 'R') {
      h.root.x = initial.x;
      h.root.y = initial.y;
      h.root.scale.set(initial.sx, initial.sy);
    } else if (e.key === 'Escape') {
      if (pinned !== null) {
        pinned = null;
        applyFocus();
      }
    }
  });

  window.addEventListener('resize', () => {
    initial = h.fitToScreen();
  });

  function toWorld(clientX: number, clientY: number): { x: number; y: number } {
    return {
      x: (clientX - h.root.x) / h.root.scale.x,
      y: (clientY - h.root.y) / h.root.scale.y,
    };
  }
}

function setAlpha(group: NodeGroup, a: number): void {
  for (const obj of group) obj.alpha = a;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}
