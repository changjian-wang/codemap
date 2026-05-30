// Pixi v8 emits `new Function()` for uniform sync by default — VS Code
// webview CSP rejects that. This sibling module patches the offending
// systems to use polyfilled code paths and must load BEFORE Application.
import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics } from 'pixi.js';
import type { CodeMapGraph } from '../../shared/types';
import { type LaneLayout, PILL_H, PAD } from './lane-layout';
import { computeForceLayout } from './force-layout';
import { buildRouter, type PillRect, type CardRect } from './edge-routing';
import { renderEdges } from './edge-renderer';
import { renderSwimlanes, renderClassCards, renderMethodPills } from './node-renderer';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T>(state: T): void;
}

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();

async function main(): Promise<void> {
  const stage = document.getElementById('stage');
  if (!(stage instanceof HTMLElement)) {
    throw new Error('#stage container missing');
  }

  const graph = loadFixture();

  const app = new Application();
  await app.init({
    background: 0x1e1e1e,
    resizeTo: stage,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  stage.appendChild(app.canvas);

  const layout = computeForceLayout(graph, app.screen.width);

  const root = app.stage;
  const bgLayer = new Container();
  const edgeLayer = new Container();
  const nodeLayer = new Container();
  const labelLayer = new Container();
  root.addChild(bgLayer);
  root.addChild(edgeLayer);
  root.addChild(nodeLayer);
  root.addChild(labelLayer);

  const layers = { bgLayer, nodeLayer, labelLayer };
  renderSwimlanes(layout, layers);
  renderClassCards(layout, layers);
  renderMethodPills(layout, graph, layers);

  const router = buildRouter(toRoutingInput(layout), graph.methodEdges);
  const edgesG = new Graphics();
  renderEdges(graph.methodEdges, router, edgesG);
  edgeLayer.addChild(edgesG);

  let initial = fitToScreen(app, root, layout);
  window.addEventListener('resize', () => {
    initial = fitToScreen(app, root, layout);
  });
  installInteraction(app, root, () => initial);

  // Pixi v8 ESM doesn't auto-register the TickerPlugin, so app.ticker is
  // undefined and the stage would never repaint. Drive it ourselves.
  const loop = (): void => {
    app.render();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  vscode.postMessage({ type: 'webview.ready' });
}

function loadFixture(): CodeMapGraph {
  const el = document.getElementById('codemap-fixture');
  if (!el || !el.textContent) {
    throw new Error('#codemap-fixture script block missing');
  }
  return JSON.parse(el.textContent) as CodeMapGraph;
}

function toRoutingInput(layout: LaneLayout): {
  methods: Record<string, PillRect>;
  classes: Record<string, CardRect>;
  pillH: number;
} {
  const methods: Record<string, PillRect> = {};
  for (const ml of Object.values(layout.methods)) {
    methods[ml.id] = {
      cy: ml.cy,
      bc: ml.bc,
      pillL: ml.pillL,
      pillR: ml.pillR,
      pillCx: ml.pillCx,
      pillCy: ml.pillCy,
    };
  }
  const classes: Record<string, CardRect> = {};
  for (const cl of Object.values(layout.classes)) {
    classes[cl.id] = { x: cl.x, y: cl.y, w: cl.w, h: cl.h };
  }
  return { methods, classes, pillH: PILL_H };
}

interface ViewState {
  x: number;
  y: number;
  sx: number;
  sy: number;
}

function fitToScreen(app: Application, root: Container, layout: LaneLayout): ViewState {
  const { minX, minY, maxX, maxY } = layout.bbox;
  const headerTop = Math.min(minY, PAD.top - 50);
  const bboxW = Math.max(1, maxX - minX);
  const bboxH = Math.max(1, maxY - headerTop);
  const w = app.screen.width;
  const h = app.screen.height;
  const margin = 40;
  const vw = Math.max(1, w - 2 * margin);
  const vh = Math.max(1, h - 2 * margin);
  const sc = Math.min(vw / bboxW, vh / bboxH, 1.5);
  root.scale.set(sc, sc);
  root.x = margin + (vw - bboxW * sc) / 2 - minX * sc;
  root.y = margin + (vh - bboxH * sc) / 2 - headerTop * sc;
  return { x: root.x, y: root.y, sx: sc, sy: sc };
}

function installInteraction(app: Application, root: Container, getInitial: () => ViewState): void {
  let dragging = false;
  let lastX = 0, lastY = 0;
  const canvas = app.canvas;

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointerup', (e: PointerEvent) => {
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    root.x += e.clientX - lastX;
    root.y += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
  });
  canvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const wx = (e.clientX - root.x) / root.scale.x;
      const wy = (e.clientY - root.y) / root.scale.y;
      root.scale.x *= factor;
      root.scale.y *= factor;
      root.x = e.clientX - wx * root.scale.x;
      root.y = e.clientY - wy * root.scale.y;
    },
    { passive: false },
  );
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'r' || e.key === 'R') {
      const initial = getInitial();
      root.x = initial.x;
      root.y = initial.y;
      root.scale.set(initial.sx, initial.sy);
    }
  });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[codemap] bootstrap failed', err);
  const stage = document.getElementById('stage');
  if (stage) {
    const message = err instanceof Error ? err.message : String(err);
    stage.textContent = `bootstrap failed: ${message}`;
    stage.style.padding = '24px';
  }
});
