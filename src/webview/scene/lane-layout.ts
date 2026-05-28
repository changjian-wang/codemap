import type { CodeMapGraph, ClassNode, VerificationState } from '../../shared/types';

export const PILL_H = 22;
export const PILL_HPAD = 10;
export const METHOD_H = 30;
export const HEADER_H = 30;
export const CARD_PAD = 12;
export const CARD_GAP = 18;
export const COL_INNER_PAD = 16;
export const COL_W_MIN = 240;
export const COL_W_MAX = 420;

export const PAD = { top: 130, left: 30, right: 30 } as const;

export interface ClassLayout {
  id: string;
  name: string;
  kind: 'real' | 'ext' | 'stub';
  bc: string;
  x: number;
  y: number;
  w: number;
  h: number;
  classNode: ClassNode | null;
  methodIds: readonly string[];
  isEntry: boolean;
  verification: VerificationState | null;
}

export interface MethodLayout {
  id: string;
  classId: string;
  bc: string;
  cx: number;
  cy: number;
  pillL: number;
  pillR: number;
  pillCx: number;
  pillCy: number;
}

export interface LaneLayout {
  classes: Record<string, ClassLayout>;
  methods: Record<string, MethodLayout>;
  visibleBcs: string[];
  colW: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Lay out class cards as columns by bounded context (capture/recall/shared/ext/...).
 * `methodLayouts[id].pill*` start at zero — the node renderer fills them in
 * once it knows the actual pill width (label-driven).
 */
export function computeLaneLayout(graph: CodeMapGraph, screenW: number): LaneLayout {
  const bcs = [...graph.boundedContexts, 'ext'];
  const buckets: Record<string, ClassLayout[]> = Object.fromEntries(bcs.map((b) => [b, []]));

  for (const c of Object.values(graph.classes)) {
    const bc = buckets[c.boundedContext] ? c.boundedContext : 'shared';
    buckets[bc].push({
      id: c.id,
      name: c.id,
      kind: 'real',
      bc,
      x: 0, y: 0, w: 0, h: 0,
      classNode: c,
      methodIds: c.methodIds,
      isEntry: !!c.isEntry,
      verification: c.verification,
    });
  }
  for (const dep of Object.values(graph.externalDeps)) {
    buckets['ext'].push({
      id: dep.id,
      name: dep.name,
      kind: 'ext',
      bc: 'ext',
      x: 0, y: 0, w: 0, h: 0,
      classNode: null,
      methodIds: [],
      isEntry: false,
      verification: null,
    });
  }

  // class-id fallback: edge target that isn't a method, ext, or real class
  // becomes an italic stub card in the ext column.
  const referenced = new Set<string>();
  for (const e of graph.methodEdges) referenced.add(e.target);
  for (const t of referenced) {
    if (graph.methods[t] || graph.externalDeps[t] || graph.classes[t]) continue;
    buckets['ext'].push({
      id: t,
      name: t,
      kind: 'stub',
      bc: 'ext',
      x: 0, y: 0, w: 0, h: 0,
      classNode: null,
      methodIds: [],
      isEntry: false,
      verification: null,
    });
  }

  const visibleBcs = bcs.filter((b) => buckets[b].length > 0);

  const colW = Math.max(
    COL_W_MIN,
    Math.min(COL_W_MAX, (screenW - PAD.left - PAD.right) / Math.max(1, visibleBcs.length)),
  );

  const classes: Record<string, ClassLayout> = {};
  const methods: Record<string, MethodLayout> = {};
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  visibleBcs.forEach((bc, ci) => {
    const colX = PAD.left + ci * colW;
    let y = PAD.top;
    for (const cl of buckets[bc]) {
      const cardW = colW - COL_INNER_PAD;
      const rowCount = Math.max(cl.methodIds.length, cl.kind === 'real' ? 0 : 1);
      const cardH = HEADER_H + rowCount * METHOD_H + CARD_PAD;

      cl.x = colX; cl.y = y; cl.w = cardW; cl.h = cardH;
      classes[cl.id] = cl;

      let my = y + HEADER_H + 10;
      for (const mid of cl.methodIds) {
        methods[mid] = {
          id: mid,
          classId: cl.id,
          bc,
          cx: colX + 18,
          cy: my + 4,
          pillL: 0, pillR: 0, pillCx: 0, pillCy: 0,
        };
        my += METHOD_H;
      }

      if (colX < minX) minX = colX;
      if (y < minY) minY = y;
      if (colX + cardW > maxX) maxX = colX + cardW;
      if (y + cardH > maxY) maxY = y + cardH;

      y += cardH + CARD_GAP;
    }
  });

  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
  minY = Math.min(minY, PAD.top - 50);

  return { classes, methods, visibleBcs, colW, bbox: { minX, minY, maxX, maxY } };
}
