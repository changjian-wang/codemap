import type { ClassNode, VerificationState } from '../../shared/types';

export const PILL_H = 22;
export const PILL_HPAD = 10;
export const METHOD_H = 30;
export const HEADER_H = 30;
export const CARD_PAD = 12;

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

/**
 * Method pill geometry. `cx` / `cy` is the pill CENTRE (force-layout output);
 * `pill*` bounds are back-filled by the node renderer once the label width is
 * known, centred on `cx` / `cy`.
 */
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

/** Bounded-context backdrop band, drawn behind every node in that BC. */
export interface Swimlane {
  bc: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaneLayout {
  classes: Record<string, ClassLayout>;
  methods: Record<string, MethodLayout>;
  swimlanes: Swimlane[];
  visibleBcs: string[];
  colW: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}
