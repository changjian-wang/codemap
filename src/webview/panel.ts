import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

let currentPanel: vscode.WebviewPanel | undefined;

export function openPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active);
    return currentPanel;
  }

  const panel = vscode.window.createWebviewPanel(
    'codemap.fixture',
    'CodeMap (Dev)',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    },
  );

  const webview = panel.webview;
  const nonce = randomBytes(16).toString('base64');
  const sceneUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'scene.js'),
  );
  const pixiUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'vendor', 'pixi.min.mjs'),
  );

  panel.webview.html = renderHtml({
    cspSource: webview.cspSource,
    nonce,
    sceneUri: sceneUri.toString(),
    pixiUri: pixiUri.toString(),
  });

  currentPanel = panel;
  panel.onDidDispose(() => {
    if (currentPanel === panel) {
      currentPanel = undefined;
    }
  });

  return panel;
}

interface HtmlContext {
  cspSource: string;
  nonce: string;
  sceneUri: string;
  pixiUri: string;
}

function renderHtml(ctx: HtmlContext): string {
  const { cspSource, nonce, sceneUri, pixiUri } = ctx;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};" />
  <title>CodeMap</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: #1e1e1e;
      color: #d4d4d4;
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      height: 100%;
      overflow: hidden;
    }
    #stage { position: absolute; inset: 0; }
  </style>
</head>
<body>
  <div id="stage"></div>
  <script type="importmap" nonce="${nonce}">
  {
    "imports": {
      "pixi.js": "${pixiUri}"
    }
  }
  </script>
  <script type="module" nonce="${nonce}" src="${sceneUri}"></script>
</body>
</html>`;
}
