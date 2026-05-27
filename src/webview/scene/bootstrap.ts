import { Application, Graphics, Text } from 'pixi.js';

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

  const app = new Application();
  await app.init({
    background: '#1e1e1e',
    resizeTo: stage,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  stage.appendChild(app.canvas);

  const card = new Graphics()
    .roundRect(40, 40, 320, 140, 6)
    .fill({ color: 0x252526 })
    .stroke({ color: 0x569cd6, width: 1.5 });
  app.stage.addChild(card);

  const title = new Text({
    text: 'CodeMap webview pipeline',
    style: {
      fill: 0xd4d4d4,
      fontFamily: 'SF Mono, Menlo, Consolas, monospace',
      fontSize: 13,
    },
  });
  title.x = 56;
  title.y = 60;
  app.stage.addChild(title);

  const body = new Text({
    text: 'Phase 1.1a placeholder — Pixi v8 ESM loaded via vendor copy + import map.',
    style: {
      fill: 0x858585,
      fontFamily: 'SF Mono, Menlo, Consolas, monospace',
      fontSize: 11,
      wordWrap: true,
      wordWrapWidth: 288,
    },
  });
  body.x = 56;
  body.y = 90;
  app.stage.addChild(body);

  vscode.postMessage({ type: 'webview.ready' });
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
