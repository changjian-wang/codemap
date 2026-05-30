// Pixi v8 emits `new Function()` for uniform sync by default — VS Code
// webview CSP rejects that. This sibling module patches the offending
// systems to use polyfilled code paths and must load BEFORE Application.
import 'pixi.js/unsafe-eval';
import { Application, Container } from 'pixi.js';
import type { CodeMapGraph, MethodEdge } from '../../shared/types';
import { type LaneLayout, PAD } from './lane-layout';
import { computeForceLayout } from './force-layout';
import { buildRouter, type PillRect, type CardRect } from './edge-routing';
import { renderEdges } from './edge-renderer';
import { renderSwimlanes, renderClassCards, renderMethodPills, renderReadingOrder } from './node-renderer';
import { installInteraction, type ViewState } from './interaction';

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
  const cards = renderClassCards(layout, layers);
  // ALL-collapsed mode: skip method pills and the reading-order overlay --
  // the cards are header-only and edges connect class card centres. Pass
  // an empty pill map to interaction so its hover/dim logic still works.
  const methodPills = renderMethodPills(layout, graph, layers);
  renderReadingOrder(layout, graph, layers);

  // Build class-level edges (collapsed view) shaped like MethodEdge so the
  // existing router / edge-renderer / interaction layer keep working
  // unchanged. Router falls back to class rects when methods[id] is empty.
  const displayEdges: MethodEdge[] = graph.classEdges.map((e, i) => ({
    id: `c${i}`,
    source: e.source,
    target: e.target,
    kind: e.kind,
    verified: e.verified,
  }));
  const displayGraph: CodeMapGraph = { ...graph, methodEdges: displayEdges };

  const router = buildRouter(toRoutingInput(layout), displayEdges);
  const edges = renderEdges(displayEdges, router, edgeLayer);

  const tooltip = ensureTooltip();
  installInteraction({
    app,
    root,
    edgeLayer,
    layout,
    graph: displayGraph,
    router,
    methodPills,
    cards,
    edges,
    tooltip,
    fitToScreen: () => fitToScreen(app, root, layout),
    onRequestOpenReference: (target, sources) => {
      vscode.postMessage({ type: 'open-reference', target, sources });
    },
    onRequestJumpToSource: (req) => {
      vscode.postMessage({ type: 'jump-to-source', req });
    },
  });

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

function ensureTooltip(): HTMLElement {
  let el = document.getElementById('codemap-tooltip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'codemap-tooltip';
    document.body.appendChild(el);
  }
  return el;
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
  return { methods, classes, pillH: 22 };
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
