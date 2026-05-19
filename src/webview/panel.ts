import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { adaptGraphForMockup, type MockupChatTurn, type MockupStats, type MockupMeta } from './graph-adapter';
import { ReadingProgressStore } from '../persistence/reading-progress';
import { jumpToSource } from '../editor/jump-to-source';
import type { ClientEvent, CodeMapGraph } from '../shared/types';

let currentPanel: vscode.WebviewPanel | undefined;
// The most recent graph shown in the panel, so client messages
// (jump_to_source, mark_read, etc.) can resolve nodeId → CodeNode without
// re-fetching from the orchestrator.
let currentGraph: CodeMapGraph | undefined;

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
      // Programmatic /focus from the webview — route through the chat
      // participant so the result is recorded as a chat turn (and the
      // stored graph is consulted via GraphStore).
      void vscode.commands.executeCommand(
        'workbench.action.chat.open',
        { query: `@codemap /focus ${msg.nodeId}` },
      );
      return;
    case 'open_chat': {
      const query = (msg.prefill ?? '').trim();
      const finalQuery = query.length > 0 && !query.startsWith('@codemap')
        ? `@codemap ${query}`
        : (query.length > 0 ? query : '@codemap ');
      void vscode.commands.executeCommand(
        'workbench.action.chat.open',
        { query: finalQuery },
      );
      return;
    }
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

  // Post-mockup script: wires the bottom chat input + quick-chips to the
  // real Copilot Chat panel, and tightens the chip filter so external nodes
  // hide when all of their callers are filtered out. Runs after the mockup
  // has built cytoscape, so cy / applyFilters / CHAT_TURNS exist.
  const isFixture = (meta?.modelLabel ?? '').toLowerCase().includes('fixture');
  const postMockup = `
    <script nonce="${nonce}">
      (function () {
        function send(msg) {
          if (window.codemap && window.codemap.postMessage) window.codemap.postMessage(msg);
        }

        // --- chat input: Enter submits to @codemap ---
        var input = document.getElementById('chatInput');
        if (input) {
          input.placeholder = 'Type a follow-up — Enter sends to @codemap in Copilot Chat';
          input.addEventListener('keydown', function (ev) {
            if (ev.key !== 'Enter') return;
            ev.preventDefault();
            var v = input.value.trim();
            send({ type: 'open_chat', prefill: v });
            input.value = '';
          });
        }

        // --- quick chips: click sends as a prefill ---
        // In real-data mode these mockup suggestions reference Lumen, so we
        // hide them entirely; in fixture mode they remain clickable.
        var quickRow = document.querySelector('.quick-chip')
          ? document.querySelector('.quick-chip').parentElement
          : null;
        var isFixture = ${JSON.stringify(isFixture)};
        if (quickRow && !isFixture) {
          quickRow.style.display = 'none';
        } else {
          document.querySelectorAll('.quick-chip').forEach(function (chip) {
            chip.style.cursor = 'pointer';
            chip.addEventListener('click', function () {
              send({ type: 'open_chat', prefill: chip.textContent.trim() });
            });
          });
        }

        // --- chip filter: auto-hide isolated externals ---
        // Runs after the mockup's chip handler has executed (listener order),
        // so cy node display has already been set. We then re-evaluate any
        // external node whose callers are all hidden.
        function refineExternals() {
          if (typeof cy === 'undefined') return;
          cy.nodes('.ext').forEach(function (n) {
            // Respect explicit hideExternal toggle (mockup already handled).
            if (n.style('display') === 'none') return;
            var incomers = n.incomers('edge');
            if (incomers.length === 0) return; // detached external — leave visible
            var anyVisible = false;
            incomers.forEach(function (e) {
              if (e.source().style('display') !== 'none') anyVisible = true;
            });
            if (!anyVisible) n.style('display', 'none');
          });
          // Re-hide edges into now-hidden externals.
          cy.edges().forEach(function (e) {
            if (e.target().style('display') === 'none' || e.source().style('display') === 'none') {
              e.style('display', 'none');
            }
          });
        }
        document.querySelectorAll('.chip').forEach(function (chip) {
          chip.addEventListener('click', refineExternals);
        });
        // Initial pass once layout is ready.
        window.addEventListener('load', function () { setTimeout(refineExternals, 50); });

        // --- relabel chips + outline sections with the real bc names ---
        // The mockup hardcodes 4 slots (Host/Capture/Recall/Shared) tied to
        // Lumen demo data. graph-adapter remaps real boundedContext strings
        // onto those 4 slots and emits meta.bcLabels so we can show the real
        // names in the UI. Without this the chips look like Lumen even when
        // analyzing a totally different repo (e.g. agent-framework).
        var bcLabels = (window.__CODEMAP_DATA__ && window.__CODEMAP_DATA__.meta && window.__CODEMAP_DATA__.meta.bcLabels) || null;
        if (bcLabels) {
          ['host', 'capture', 'recall', 'shared'].forEach(function (slot) {
            var label = bcLabels[slot];
            if (!label) return;
            // Chip text: keep the colored marker span, replace the trailing text.
            var chip = document.querySelector('.chip.bc-chip[data-bc="' + slot + '"]');
            if (chip) {
              var marker = chip.querySelector('.bc-marker');
              chip.textContent = '';
              if (marker) chip.appendChild(marker);
              chip.appendChild(document.createTextNode(label));
            }
            // Outline group title: the <div class="bc-group"> sibling above each
            // <div id="outline{Slot}"> contains the section heading.
            var outlineEl = document.getElementById('outline' + slot.charAt(0).toUpperCase() + slot.slice(1));
            if (outlineEl) {
              var group = outlineEl.previousElementSibling;
              if (group && group.classList && group.classList.contains('bc-group')) {
                var dot = group.querySelector('.bc-dot');
                group.textContent = '';
                if (dot) group.appendChild(dot);
                group.appendChild(document.createTextNode(label));
              }
            }
          });
        }
    </script>
  `;
  html = html.replace('</body>', `${postMockup}</body>`);

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src ${webview.cspSource} 'unsafe-inline' https:; style-src ${webview.cspSource} 'unsafe-inline' https:; connect-src https:;">`;
  html = html.replace('<head>', `<head>\n${cspMeta}`);
  return html;
}
