import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { jumpToSource, type JumpRequest } from '../editor/jump-to-source';
import type { CodeMapGraph } from '../shared/types';

let currentPanel: vscode.WebviewPanel | undefined;

export function openPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  const fixturePath = path.join(
    context.extensionPath,
    'eval', 'samples', 'lumen-mini', 'fixture.json',
  );
  const fixtureJson = fs.readFileSync(fixturePath, 'utf8');
  return showGraphJson(context, fixtureJson, 'CodeMap (Dev)');
}

/**
 * Render a live CodeMapGraph in the webview. Reuses the dev fixture panel
 * if one is open; otherwise creates a new panel. Phase 3.3a entry point
 * for the chat participant rewire in 3.3b.
 */
export function showGraph(
  context: vscode.ExtensionContext,
  graph: CodeMapGraph,
  title = 'CodeMap',
): vscode.WebviewPanel {
  return showGraphJson(context, JSON.stringify(graph), title);
}

function showGraphJson(
  context: vscode.ExtensionContext,
  graphJson: string,
  title: string,
): vscode.WebviewPanel {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active);
    currentPanel.title = title;
    currentPanel.webview.html = buildHtml(context, currentPanel, graphJson);
    return currentPanel;
  }

  const panel = vscode.window.createWebviewPanel(
    'codemap.fixture',
    title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    },
  );

  panel.webview.html = buildHtml(context, panel, graphJson);

  currentPanel = panel;
  panel.onDidDispose(() => {
    if (currentPanel === panel) {
      currentPanel = undefined;
    }
  });

  // Bridge ext / stub card clicks to a VS Code message. Phase 1.5 will
  // replace this with the real jump-to-source path; for now we just list
  // the in-graph call sites so the click is observably wired.
  panel.webview.onDidReceiveMessage((msg: unknown) => {
    if (isOpenReference(msg)) {
      const summary = msg.sources.length === 0
        ? `${msg.target}: no in-graph call sites`
        : `${msg.target} call sites: ${msg.sources.join(', ')}`;
      vscode.window.showInformationMessage(summary);
      return;
    }
    if (isJumpToSource(msg)) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        vscode.window.showWarningMessage(
          'Open a workspace folder before jumping from the CodeMap fixture.',
        );
        return;
      }
      void jumpToSource(root, msg.req);
    }
  });

  return panel;
}

interface OpenReferenceMessage {
  type: 'open-reference';
  target: string;
  sources: string[];
}

interface JumpToSourceMessage {
  type: 'jump-to-source';
  req: JumpRequest;
}

function isOpenReference(msg: unknown): msg is OpenReferenceMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.type === 'open-reference' &&
    typeof m.target === 'string' &&
    Array.isArray(m.sources) &&
    m.sources.every((s) => typeof s === 'string')
  );
}

function isJumpToSource(msg: unknown): msg is JumpToSourceMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'jump-to-source') return false;
  const req = m.req as Record<string, unknown> | undefined;
  if (!req || typeof req !== 'object') return false;
  return (
    typeof req.file === 'string' &&
    typeof req.nodeId === 'string' &&
    (req.verification === 'verified' ||
      req.verification === 'partial' ||
      req.verification === 'unverified')
  );
}

interface HtmlContext {
  cspSource: string;
  nonce: string;
  sceneUri: string;
  graphJson: string;
}

function buildHtml(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  graphJson: string,
): string {
  const webview = panel.webview;
  const nonce = randomBytes(16).toString('base64');
  const sceneUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'scene.js'),
  );
  return renderHtml({
    cspSource: webview.cspSource,
    nonce,
    sceneUri: sceneUri.toString(),
    graphJson,
  });
}

function renderHtml(ctx: HtmlContext): string {
  const { cspSource, nonce, sceneUri, graphJson } = ctx;
  // Embed the graph as a non-executed JSON script block so the webview can
  // parse it via `document.getElementById('codemap-fixture').textContent`.
  // Escape `</script>` defensively to prevent early tag closure. The DOM id
  // stays `codemap-fixture` so scene.js (loaded as a separate bundle) keeps
  // working unchanged across the dev fixture path and the live graph path.
  const safeGraph = graphJson.replace(/<\/script/gi, '<\\/script');
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
    #codemap-tooltip {
      position: fixed;
      display: none;
      max-width: 360px;
      padding: 6px 10px;
      background: rgba(30, 30, 30, 0.96);
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      color: #d4d4d4;
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 11px;
      line-height: 1.45;
      pointer-events: none;
      white-space: pre-wrap;
      z-index: 10;
    }
  </style>
</head>
<body>
  <div id="stage"></div>
  <div id="codemap-tooltip"></div>
  <script type="application/json" id="codemap-fixture" nonce="${nonce}">${safeGraph}</script>
  <script type="module" nonce="${nonce}" src="${sceneUri}"></script>
</body>
</html>`;
}

