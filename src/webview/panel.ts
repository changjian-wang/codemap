import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DEMO_GRAPH } from './demo-fixture';
import type { ClientEvent, ServerEvent } from '../shared/types';

let currentPanel: vscode.WebviewPanel | undefined;

export async function showDemoGraph(context: vscode.ExtensionContext): Promise<void> {
  if (currentPanel) {
    currentPanel.reveal();
    pushGraph(currentPanel.webview);
    return;
  }

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

  currentPanel.webview.html = renderHtml(context, currentPanel.webview);

  currentPanel.webview.onDidReceiveMessage((msg: ClientEvent) => {
    handleClientMessage(msg, context);
  });
}

function pushGraph(webview: vscode.Webview): void {
  const event: ServerEvent = { type: 'graph_replaced', graph: DEMO_GRAPH };
  void webview.postMessage(event);
}

function handleClientMessage(msg: ClientEvent, context: vscode.ExtensionContext): void {
  switch (msg.type) {
    case 'ready':
      if (currentPanel) pushGraph(currentPanel.webview);
      return;
    case 'jump_to_source': {
      // W1 stub. W2-W4 will implement the 4-level fallback (v2 §7.6).
      vscode.window.showInformationMessage(
        `jump_to_source: ${msg.nodeId}${msg.method ? '.' + msg.method : ''} (stub — implement in W4)`,
      );
      return;
    }
    case 'mark_read':
    case 'mark_method_read': {
      // W2 persistence task; for now just log.
      void context.workspaceState.update(`codemap.read.${'nodeId' in msg ? msg.nodeId : ''}`, true);
      return;
    }
    case 'reset_progress':
      void context.workspaceState.update('codemap.readingProgress', undefined);
      return;
    case 'request_focus':
    case 'open_chat':
      return;
  }
}

function renderHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  // W1: we reuse the mockup HTML as-is so the UI matches the spec before the
  // React port lands. The mockup carries its own inline data; W2 will swap
  // this to a thin host page that loads dist/webview.js.
  const mockupPath = path.join(context.extensionPath, 'docs', 'mockups', 'lumen-backend-v3.html');
  let html = '';
  try {
    html = fs.readFileSync(mockupPath, 'utf8');
  } catch {
    return `<!doctype html><html><body style="background:#1e1e1e;color:#ccc;font-family:sans-serif;padding:24px;">
      <h2>CodeMap</h2>
      <p>Mockup file not found at <code>${mockupPath}</code>. Run the W1 build that copies the mockup into <code>docs/mockups/</code>.</p>
    </body></html>`;
  }

  // Inject the WebView CSP nonce + acquireVsCodeApi bridge so the page can
  // postMessage back to the extension. The mockup itself runs unchanged.
  const nonce = Math.random().toString(36).slice(2);
  const bridge = `
    <script nonce="${nonce}">
      const vscodeApi = acquireVsCodeApi();
      window.codemap = window.codemap || {};
      window.codemap.postMessage = (msg) => vscodeApi.postMessage(msg);
      window.addEventListener('DOMContentLoaded', () => {
        vscodeApi.postMessage({ type: 'ready' });
      });
    </script>
  `;
  html = html.replace('</head>', `${bridge}</head>`);
  // Allow inline scripts in this controlled environment (mockup uses them).
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src ${webview.cspSource} 'unsafe-inline' https:; style-src ${webview.cspSource} 'unsafe-inline' https:; connect-src https:;">`;
  html = html.replace('<head>', `<head>\n${cspMeta}`);
  return html;
}
