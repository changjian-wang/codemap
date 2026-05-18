import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DEMO_GRAPH, DEMO_CHAT_TURNS } from './demo-fixture';
import { adaptGraphForMockup, type MockupChatTurn, type MockupStats, type MockupMeta } from './graph-adapter';
import { ReadingProgressStore } from '../persistence/reading-progress';
import { jumpToSource } from '../editor/jump-to-source';
import type { ClientEvent, CodeMapGraph } from '../shared/types';

let currentPanel: vscode.WebviewPanel | undefined;
// The most recent graph shown in the panel, so client messages
// (jump_to_source, mark_read, etc.) can resolve nodeId → CodeNode without
// re-fetching from the orchestrator.
let currentGraph: CodeMapGraph | undefined;

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
  stats?: MockupStats,
  meta?: MockupMeta,
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

  currentGraph = graph;
  currentPanel.webview.html = renderHtml(context, currentPanel.webview, graph, chatTurns, stats, meta);
}

function handleClientMessage(msg: ClientEvent, context: vscode.ExtensionContext): void {
  const progress = new ReadingProgressStore(context.workspaceState);
  switch (msg.type) {
    case 'ready':
      // The page boots with the injected payload already in place, so 'ready'
      // is informational. We deliberately do NOT re-render here — that would
      // loop.
      return;
    case 'jump_to_source': {
      const node = currentGraph?.nodes[msg.nodeId];
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!node || !workspaceRoot) {
        vscode.window.showWarningMessage(
          `Cannot jump: graph not loaded or no workspace open.`,
        );
        return;
      }
      const methodInfo = msg.method
        ? node.methods.find(m => m.name === msg.method)
        : undefined;
      void jumpToSource(workspaceRoot, {
        file: node.file,
        nodeId: node.id,
        method: msg.method,
        classLine: node.range.startLine,
        methodLine: methodInfo?.line,
        verification: node.verification,
      });
      return;
    }
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
  stats?: MockupStats,
  meta?: MockupMeta,
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

  const mockupData = adaptGraphForMockup(graph, chatTurns, stats, meta);
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
