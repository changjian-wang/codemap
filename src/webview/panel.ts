import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DEMO_GRAPH, DEMO_CHAT_TURNS } from './demo-fixture';
import { adaptGraphForMockup, type MockupChatTurn } from './graph-adapter';
import { ReadingProgressStore } from '../persistence/reading-progress';
import type { ClientEvent, CodeMapGraph } from '../shared/types';

let currentPanel: vscode.WebviewPanel | undefined;

export async function showDemoGraph(context: vscode.ExtensionContext): Promise<void> {
  await showGraph(context, DEMO_GRAPH, DEMO_CHAT_TURNS);
}

/**
 * Open or refocus the WebView panel, rendering the given graph. Re-rendering
 * is currently a panel-html refresh (W1); W2 swaps this for postMessage-based
 * incremental updates once the React UI lands.
 */
export async function showGraph(
  context: vscode.ExtensionContext,
  graph: CodeMapGraph,
  chatTurns: MockupChatTurn[] = [],
): Promise<void> {
  if (!currentPanel) {
    currentPanel = vscode.window.createWebviewPanel(
      'codemap.graphPanel',
      'CodeMap — Workspace',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'dist')),
          vscode.Uri.file(path.join(context.extensionPath, 'docs', 'mockups')),
        ],
      },
    );
    currentPanel.onDidDispose(() => {
      currentPanel = undefined;
    });
    currentPanel.webview.onDidReceiveMessage((msg: ClientEvent) =>
      handleClientMessage(msg, context),
    );
  } else {
    currentPanel.reveal();
  }

  currentPanel.webview.html = renderHtml(context, currentPanel.webview, graph, chatTurns);
}

function handleClientMessage(msg: ClientEvent, context: vscode.ExtensionContext): void {
  const progress = new ReadingProgressStore(context.workspaceState);
  switch (msg.type) {
    case 'ready':
      // The page boots with the injected payload already in place, so 'ready'
      // is informational. We deliberately do NOT re-render here — that would
      // loop.
      return;
    case 'jump_to_source':
      vscode.window.showInformationMessage(
        `jump_to_source: ${msg.nodeId}${msg.method ? '.' + msg.method : ''} (stub — implement in W4)`,
      );
      return;
    case 'mark_read':
      void progress.setNodeRead(msg.nodeId, msg.read);
      return;
    case 'mark_method_read':
      void progress.setMethodRead(msg.nodeId, msg.method, msg.read);
      return;
    case 'reset_progress':
      void progress.reset();
      return;
    case 'request_focus':
    case 'open_chat':
      return;
  }
}

function renderHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  graph: CodeMapGraph,
  chatTurns: MockupChatTurn[],
): string {
  const mockupPath = path.join(context.extensionPath, 'docs', 'mockups', 'lumen-backend-v3.html');
  let html: string;
  try {
    html = fs.readFileSync(mockupPath, 'utf8');
  } catch {
    return `<!doctype html><html><body style="background:#1e1e1e;color:#ccc;font-family:sans-serif;padding:24px;">
      <h2>CodeMap</h2>
      <p>Mockup file not found at <code>${mockupPath}</code>. Ensure docs/mockups is intact.</p>
    </body></html>`;
  }

  const mockupData = adaptGraphForMockup(graph, chatTurns);
  // Embed as a JSON string and parse on the page — avoids HTML/JS escaping
  // pitfalls with < / backticks / quotes in intent text.
  const payload = JSON.stringify(mockupData).replace(/</g, '\\u003c');
  const nonce = Math.random().toString(36).slice(2);
  const injection = `
    <script nonce="${nonce}">
      window.__CODEMAP_DATA__ = JSON.parse(${JSON.stringify(payload)});
      const vscodeApi = acquireVsCodeApi();
      window.codemap = window.codemap || {};
      window.codemap.postMessage = (msg) => vscodeApi.postMessage(msg);
      window.addEventListener('DOMContentLoaded', () => {
        vscodeApi.postMessage({ type: 'ready' });
      });
    </script>
  `;
  html = html.replace('</head>', `${injection}</head>`);

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src ${webview.cspSource} 'unsafe-inline' https:; style-src ${webview.cspSource} 'unsafe-inline' https:; connect-src https:;">`;
  html = html.replace('<head>', `<head>\n${cspMeta}`);
  return html;
}
