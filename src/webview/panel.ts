import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { adaptGraphForMockup, type MockupChatTurn, type MockupStats, type MockupMeta } from './graph-adapter';
import { ReadingProgressStore, applyReadingProgress } from '../persistence/reading-progress';
import { jumpToSource } from '../editor/jump-to-source';
import { formatYaml, formatStandaloneHtml, EXPORT_SPECS, type ExportFormat } from '../export/formatters';
import type { ClientEvent, CodeMapGraph } from '../shared/types';

let currentPanel: vscode.WebviewPanel | undefined;
// The most recent graph shown in the panel, so client messages
// (jump_to_source, mark_read, etc.) can resolve nodeId → CodeNode without
// re-fetching from the orchestrator.
let currentGraph: CodeMapGraph | undefined;
// Render-time context kept so 'export_graph' can produce a snapshot that
// matches what the user is currently looking at (chat turns, stats, meta).
let currentChatTurns: MockupChatTurn[] = [];
let currentStats: MockupStats | undefined;
let currentMeta: MockupMeta | undefined;
// The workspace folder the current graph was generated against. Multi-root
// workspaces need this so `jump_to_source` doesn't resolve `node.file` against
// the first folder when the graph actually came from another.
let currentWorkspaceRoot: vscode.Uri | undefined;

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
  workspaceRoot?: vscode.Uri,
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
  currentWorkspaceRoot = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  currentChatTurns = chatTurns;
  currentStats = stats;
  currentMeta = meta;
  // Overlay persisted "mark as read" state — the orchestrator always emits
  // fresh nodes with readState='unread', but the user's prior marks (stored
  // in workspaceState) should still surface on this render.
  const progressSnapshot = new ReadingProgressStore(context.workspaceState).snapshot();
  const overlaidGraph = applyReadingProgress(graph, progressSnapshot);
  currentPanel.webview.html = renderHtml(context, currentPanel.webview, overlaidGraph, chatTurns, stats, meta);
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
      const workspaceRoot = currentWorkspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri;
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
    case 'pick_scope':
      void pickScopeAndRegenerate(msg.currentScope, msg.rootName);
      return;
    case 'export_graph':
      void exportCurrentGraph(context, msg.format);
      return;
  }
}

async function exportCurrentGraph(
  context: vscode.ExtensionContext,
  preferred?: ExportFormat,
): Promise<void> {
  if (!currentGraph) {
    vscode.window.showWarningMessage('No graph in the panel yet — run @codemap first.');
    return;
  }
  // Format pick: honor the message hint when present, otherwise prompt.
  let format: ExportFormat | undefined = preferred;
  if (!format) {
    const items = (Object.values(EXPORT_SPECS) as { format: ExportFormat; label: string; description: string }[]).map(s => ({
      label: s.label,
      description: s.description,
      format: s.format,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Export CodeMap graph',
      placeHolder: 'Choose an export format',
    });
    if (!pick) return;
    format = pick.format;
  }
  const spec = EXPORT_SPECS[format];

  const rootForDialog =
    currentWorkspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  const safeScope = (currentGraph.scope || 'workspace').replace(/[^A-Za-z0-9_.-]/g, '-');
  const defaultName = `codemap-${safeScope}.${spec.extension}`;
  const defaultUri = rootForDialog
    ? vscode.Uri.file(path.join(rootForDialog.fsPath, defaultName))
    : vscode.Uri.file(defaultName);

  const saveAs = await vscode.window.showSaveDialog({
    title: `Export CodeMap (${spec.label})`,
    defaultUri,
    filters: { [spec.label]: [spec.extension] },
  });
  if (!saveAs) return;

  try {
    let body: string;
    if (format === 'yaml') {
      body = formatYaml(currentGraph);
    } else {
      // HTML standalone snapshot: read the same mockup template the panel
      // uses and inject the current MockupData (graph + chat turns + stats
      // + meta). The mockup's own scripts handle rendering offline.
      const mockupPath = path.join(context.extensionPath, 'docs', 'mockups', 'codemap-view.html');
      const mockupTemplate = fs.readFileSync(mockupPath, 'utf8');
      const mockupData = adaptGraphForMockup(
        currentGraph,
        currentChatTurns,
        currentStats,
        currentMeta,
      );
      body = formatStandaloneHtml(mockupTemplate, mockupData);
    }
    await vscode.workspace.fs.writeFile(saveAs, Buffer.from(body, 'utf8'));
    const open = 'Open File';
    const reveal = 'Reveal in Explorer';
    const action = await vscode.window.showInformationMessage(
      `Exported ${Object.keys(currentGraph.nodes).length} classes to ${path.basename(saveAs.fsPath)}.`,
      open,
      reveal,
    );
    if (action === open) {
      const doc = await vscode.workspace.openTextDocument(saveAs);
      await vscode.window.showTextDocument(doc);
    } else if (action === reveal) {
      await vscode.commands.executeCommand('revealFileInOS', saveAs);
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `Export failed: ${(err as Error).message}`,
    );
  }
}

async function pickScopeAndRegenerate(
  currentScope: string | undefined,
  rootNameHint?: string,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage('No workspace folder open.');
    return;
  }
  // Prefer the explicit rootName carried by the pick_scope message (set by
  // the webview from the visible breadcrumb). Falls back to the module-level
  // `currentWorkspaceRoot`, which can be `undefined` after a window reload
  // re-creates the extension host while the webview is reopened from the
  // persisted graph store.
  const byHint = rootNameHint
    ? folders.find(f => f.name.toLowerCase() === rootNameHint.toLowerCase())
    : undefined;
  const byState = currentWorkspaceRoot
    ? folders.find(f => f.uri.fsPath === currentWorkspaceRoot!.fsPath)
    : undefined;
  const workspaceFolder = byHint ?? byState ?? folders[0]!;
  // Keep module state in sync so jump_to_source on the same panel uses the
  // right root even before the next showGraph call lands.
  currentWorkspaceRoot = workspaceFolder.uri;
  const rootFs = workspaceFolder.uri.fsPath;
  // Multi-root only: when the active folder is NOT the first one, we must
  // prefix the produced scope with `<folderName>/` so the chat-side
  // `resolveScope` lands on the right root (bare relative paths still fall
  // back to the first folder).
  const needsRootPrefix = folders.length > 1 && workspaceFolder !== folders[0];
  const rootPrefix = needsRootPrefix ? `${workspaceFolder.name}/` : '';

  // Default the OS file dialog to the current scope subfolder when one is
  // active, so re-analyzing typically means "pick something nearby" rather
  // than navigating back from the workspace root every time. Falls back to
  // the workspace folder if the scope path doesn't resolve to a real dir.
  const dialogDefaultUri = (() => {
    if (!currentScope) return workspaceFolder.uri;
    const candidatePath = path.join(rootFs, ...currentScope.split('/'));
    try {
      const st = fs.statSync(candidatePath);
      if (st.isDirectory()) return vscode.Uri.file(candidatePath);
      // For file scopes, open the parent directory.
      return vscode.Uri.file(path.dirname(candidatePath));
    } catch {
      return workspaceFolder.uri;
    }
  })();

  type ScopeAction = 'workspace' | 'folder' | 'file' | 'type';
  interface ScopeItem extends vscode.QuickPickItem { action: ScopeAction; }
  const items: ScopeItem[] = [
    { label: '$(root-folder) Whole workspace', detail: workspaceFolder.name, action: 'workspace' },
    { label: '$(folder-opened) Pick folder…', detail: `Browse for a folder under ${workspaceFolder.name}`, action: 'folder' },
    { label: '$(file) Pick file…', detail: `Browse for a single file under ${workspaceFolder.name}`, action: 'file' },
    { label: '$(edit) Type path…', detail: currentScope ? `Current: ${currentScope}` : 'Workspace-relative path', action: 'type' },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: `Re-analyze with scope (${workspaceFolder.name})`,
    placeHolder: 'Choose the scope for the next @codemap run',
  });
  if (!pick) return;

  let scope: string | undefined;
  switch (pick.action) {
    case 'workspace':
      // Whole-folder re-analysis: address the active root explicitly so we
      // don't accidentally retarget the first root.
      scope = needsRootPrefix ? workspaceFolder.name : undefined;
      break;
    case 'folder': {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: dialogDefaultUri,
        openLabel: 'Use as scope',
      });
      if (!picked || picked.length === 0) return;
      const rel = toWorkspaceRelative(picked[0].fsPath, rootFs);
      if (rel === undefined) {
        vscode.window.showWarningMessage(
          `Selected folder is outside \`${workspaceFolder.name}\`.`,
        );
        return;
      }
      scope = rel === '' ? (needsRootPrefix ? workspaceFolder.name : undefined) : `${rootPrefix}${rel}`;
      break;
    }
    case 'file': {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri: dialogDefaultUri,
        openLabel: 'Use as scope',
        // Restrict the picker to the languages the analyzer actually
        // supports so the user can't accidentally pick a README / json /
        // png as a "scope" and watch the orchestrator error out 30s later.
        // Mirrors DEFAULT_SCAN_OPTIONS.extensions in workspace-scanner.ts.
        filters: {
          'Source files': ['cs', 'ts', 'tsx', 'js', 'jsx', 'py'],
          'All files': ['*'],
        },
      });
      if (!picked || picked.length === 0) return;
      const rel = toWorkspaceRelative(picked[0].fsPath, rootFs);
      if (rel === undefined) {
        vscode.window.showWarningMessage(
          `Selected file is outside \`${workspaceFolder.name}\`.`,
        );
        return;
      }
      scope = `${rootPrefix}${rel}`;
      break;
    }
    case 'type': {
      const typed = await vscode.window.showInputBox({
        title: `Scope path (${workspaceFolder.name})`,
        prompt: 'Workspace-relative path (folder or file). Leave empty for the whole folder.',
        value: currentScope ?? '',
        placeHolder: 'e.g. sdk/storage  or  src/main.ts',
      });
      if (typed === undefined) return;
      const trimmed = typed.trim();
      if (trimmed.length === 0) {
        scope = needsRootPrefix ? workspaceFolder.name : undefined;
      } else if (
        // Already absolute, or already prefixed with the folder name — trust
        // the user verbatim. Otherwise prepend the folder prefix so the
        // re-analysis stays on the active root.
        /^[a-zA-Z]:[\\\/]/.test(trimmed) ||
        trimmed.startsWith('/') ||
        trimmed.split(/[\\\/]/, 1)[0]!.toLowerCase() === workspaceFolder.name.toLowerCase()
      ) {
        scope = trimmed;
      } else {
        scope = `${rootPrefix}${trimmed}`;
      }
      break;
    }
  }

  const query = scope ? `@codemap /scope ${scope}` : '@codemap generate codemap';
  await vscode.commands.executeCommand('workbench.action.chat.open', { query });
}

function toWorkspaceRelative(fsPath: string, rootFs: string): string | undefined {
  const rel = path.relative(rootFs, fsPath);
  if (rel === '') return '';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

function renderHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  graph: CodeMapGraph,
  chatTurns: MockupChatTurn[],
  stats?: MockupStats,
  meta?: MockupMeta,
): string {
  const mockupPath = path.join(context.extensionPath, 'docs', 'mockups', 'codemap-view.html');
  let html: string;
  try {
    html = fs.readFileSync(mockupPath, 'utf8');
  } catch {
    return `<!doctype html><html><body style="background:#1e1e1e;color:#ccc;font-family:sans-serif;padding:24px;">
      <h2>CodeMap</h2>
      <p>Mockup file not found at <code>${mockupPath}</code>. Ensure docs/mockups is intact.</p>
    </body></html>`;
  }

  // Replace the unpkg.com CDN URLs with locally bundled vendor scripts so the
  // graph renders even on machines without external network access (or where
  // unpkg.com is blocked / slow). The CSP only allows `${webview.cspSource}`
  // for scripts, so unpkg also gets refused in stricter setups.
  const vendorDir = vscode.Uri.file(path.join(context.extensionPath, 'dist', 'vendor'));
  const cyUri  = webview.asWebviewUri(vscode.Uri.joinPath(vendorDir, 'cytoscape.min.js')).toString();
  const dagUri = webview.asWebviewUri(vscode.Uri.joinPath(vendorDir, 'dagre.min.js')).toString();
  const cdaUri = webview.asWebviewUri(vscode.Uri.joinPath(vendorDir, 'cytoscape-dagre.js')).toString();
  html = html
    .replace(/https:\/\/unpkg\.com\/cytoscape@[^"']+/g, cyUri)
    .replace(/https:\/\/unpkg\.com\/dagre@[^"']+/g, dagUri)
    .replace(/https:\/\/unpkg\.com\/cytoscape-dagre@[^"']+/g, cdaUri);

  const mockupData = adaptGraphForMockup(graph, chatTurns, stats, meta);
  // Embed as a JSON string and parse on the page — avoids HTML/JS escaping
  // pitfalls with < / backticks / quotes in intent text.
  const payload = JSON.stringify(mockupData).replace(/</g, '\\u003c');
  const nonce = Math.random().toString(36).slice(2);
  const injection = `
    <script nonce="${nonce}">
      window.__CODEMAP_DATA__ = JSON.parse(${JSON.stringify(payload)});
      // Surface webview-side JS errors directly on the page — without this,
      // a single uncaught exception silently halts the mockup script and the
      // page sticks on its hardcoded fixture values. Wrapped in try so we
      // don't break in environments where document.body is missing.
      window.addEventListener('error', function (e) {
        try {
          var bar = document.getElementById('__cm_err_bar') || (function () {
            var b = document.createElement('div');
            b.id = '__cm_err_bar';
            b.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#5e2020;color:#fff;padding:6px 10px;font-family:Consolas,monospace;font-size:11px;z-index:9999;border-top:1px solid #f48771;max-height:60vh;overflow:auto;';
            document.body.appendChild(b);
            return b;
          })();
          var msg = (e && e.message) || 'error';
          var src = (e && e.filename) ? ' @ ' + e.filename + ':' + e.lineno + ':' + e.colno : '';
          var row = document.createElement('div');
          row.textContent = '⚠ ' + msg + src;
          bar.appendChild(row);
        } catch (_) { /* swallow */ }
      });
      const vscodeApi = acquireVsCodeApi();
      window.codemap = window.codemap || {};
      window.codemap.postMessage = (msg) => vscodeApi.postMessage(msg);
      window.addEventListener('DOMContentLoaded', () => {
        vscodeApi.postMessage({ type: 'ready' });
      });
    </script>
    <style nonce="${nonce}">
      /* Slash command autocomplete popup — sits on top of the chat input row.
         The mockup's .chat-input-row needs position: relative so the popup
         anchors correctly; we set that on the row itself at runtime too. */
      .slash-popup {
        position: absolute;
        left: 14px; right: 14px; bottom: 100%;
        margin-bottom: 4px;
        background: var(--vs-bg-panel);
        border: 1px solid var(--vs-border);
        border-radius: 4px;
        box-shadow: 0 -4px 14px rgba(0,0,0,0.35);
        z-index: 50;
        max-height: 240px;
        overflow-y: auto;
      }
      .slash-popup .si {
        padding: 6px 12px;
        font-size: 12px;
        border-bottom: 1px solid var(--vs-border-soft);
        cursor: pointer;
        color: var(--vs-text);
      }
      .slash-popup .si:last-child { border-bottom: 0; }
      .slash-popup .si.active { background: rgba(78, 161, 255, 0.14); }
      .slash-popup .si-cmd  { color: var(--vs-accent); font-family: Consolas, monospace; font-weight: 600; }
      .slash-popup .si-args { color: var(--vs-text-dim); font-family: Consolas, monospace; margin-left: 4px; }
      .slash-popup .si-desc { color: var(--vs-text-dim); font-size: 11px; margin-top: 2px; }
    </style>
  `;
  html = html.replace('</head>', `${injection}</head>`);

  // Post-mockup script: wires the bottom chat input + quick-chips to the
  // real Copilot Chat panel, tightens the chip filter so external nodes
  // hide when all of their callers are filtered out, relabels the 4 fixed
  // chip slots with real bounded-context names, and draws a real minimap.
  // Runs after the mockup has built cytoscape, so `cy`, `applyFilters`,
  // `CHAT_TURNS` exist on the global scope.
  const isFixture = (meta?.modelLabel ?? '').toLowerCase().includes('fixture');
  const postMockup = `
    <script nonce="${nonce}">
      (function () {
        function send(msg) {
          if (window.codemap && window.codemap.postMessage) window.codemap.postMessage(msg);
        }

        // --- repo pill: click to pick a new scope and re-analyze ---
        // The breadcrumb shows workspace · scope. Clicking it sends pick_scope
        // to the extension host, which opens a QuickPick and routes the user
        // through @codemap /scope <path> (or @codemap generate codemap).
        (function () {
          var pill = document.querySelector('.repo-pill');
          if (!pill) return;
          pill.style.cursor = 'pointer';
          pill.title = 'Click to change scope and re-analyze';
          pill.addEventListener('mouseenter', function () {
            var name = pill.querySelector('#repoName');
            var scope = pill.querySelector('#repoScope');
            if (name) name.style.textDecoration = 'underline';
            if (scope) scope.style.textDecoration = 'underline';
          });
          pill.addEventListener('mouseleave', function () {
            var name = pill.querySelector('#repoName');
            var scope = pill.querySelector('#repoScope');
            if (name) name.style.textDecoration = 'none';
            if (scope) scope.style.textDecoration = 'none';
          });
          pill.addEventListener('click', function () {
            var scopeEl = document.getElementById('repoScope');
            var nameEl = document.getElementById('repoName');
            // repoScope renders as "· <path>"; strip the leading marker.
            var raw = scopeEl ? (scopeEl.textContent || '') : '';
            var current = raw.replace(/^\\s*\u00b7\\s*/, '').trim();
            var rootName = nameEl ? (nameEl.textContent || '').trim() : '';
            send({ type: 'pick_scope', currentScope: current || undefined, rootName: rootName || undefined });
          });
        })();

        // --- chat input: Enter submits to @codemap, with slash autocomplete ---
        // The popup mirrors the participant.ts "Try one of" fallback so the
        // user never has to remember the exact command name. Picking a command
        // also rewrites the placeholder into an example string so the user
        // sees what argument to type next.
        var SLASH_COMMANDS = [
          { cmd: '/scope',   args: '<path>',     desc: 'Limit analysis to a subpath',
            example: '/scope <path>  \u2014 e.g. /scope sdk/storage' },
          { cmd: '/focus',   args: '<Class>',    desc: 'Re-center the graph on a class',
            example: '/focus <Class>  \u2014 e.g. /focus IngestUrlHandler' },
          { cmd: '/why',     args: '<Class>',    desc: 'Explain partial / unverified state',
            example: '/why <Class>  \u2014 e.g. /why AskByQueryHandler' },
          { cmd: '/explain', args: 'unverified', desc: 'List all unverified nodes',
            example: '/explain unverified' },
        ];
        var DEFAULT_PLACEHOLDER = 'Type a follow-up \u2014 Enter sends. Type / for commands.';

        var input = document.getElementById('chatInput');
        if (input) {
          input.placeholder = DEFAULT_PLACEHOLDER;

          var row = input.parentElement; // .chat-input-row
          if (row) row.style.position = 'relative';
          var popup = document.createElement('div');
          popup.className = 'slash-popup';
          popup.style.display = 'none';
          if (row) row.appendChild(popup);
          var activeIdx = 0;

          function commandFor(value) {
            var head = (value || '').trim().split(/\s+/)[0];
            for (var i = 0; i < SLASH_COMMANDS.length; i++) {
              if (SLASH_COMMANDS[i].cmd === head) return SLASH_COMMANDS[i];
            }
            return null;
          }
          function filterList(value) {
            var v = (value || '').trim();
            if (!v || v.charAt(0) !== '/') return [];
            var head = v.split(/\s+/)[0];
            // Once the user has typed past the command (added a space + arg),
            // we stop offering suggestions — the popup would just be noise.
            if (v.length > head.length && /\s/.test(v.charAt(head.length))) return [];
            var lower = head.toLowerCase();
            return SLASH_COMMANDS.filter(function (s) { return s.cmd.indexOf(lower) === 0; });
          }
          function renderPopup(items) {
            if (!items.length) { popup.style.display = 'none'; return; }
            if (activeIdx >= items.length) activeIdx = 0;
            var html = '';
            for (var i = 0; i < items.length; i++) {
              var s = items[i];
              html += '<div class="si' + (i === activeIdx ? ' active' : '') + '" data-cmd="' + s.cmd + '">' +
                '<span class="si-cmd">' + s.cmd + '</span>' +
                '<span class="si-args">' + s.args + '</span>' +
                '<div class="si-desc">' + s.desc + '</div>' +
                '</div>';
            }
            popup.innerHTML = html;
            popup.style.display = 'block';
            Array.prototype.forEach.call(popup.querySelectorAll('.si'), function (el, i) {
              el.addEventListener('mouseenter', function () {
                activeIdx = i;
                Array.prototype.forEach.call(popup.children, function (c, j) {
                  c.classList.toggle('active', j === activeIdx);
                });
              });
              // mousedown (not click) so it fires before blur hides the popup.
              el.addEventListener('mousedown', function (ev) {
                ev.preventDefault();
                insertCommand(el.getAttribute('data-cmd'));
              });
            });
          }
          function insertCommand(cmd) {
            var entry = null;
            for (var i = 0; i < SLASH_COMMANDS.length; i++) {
              if (SLASH_COMMANDS[i].cmd === cmd) { entry = SLASH_COMMANDS[i]; break; }
            }
            if (!entry) return;
            // /explain only accepts a single fixed arg today, so we just fill
            // the whole canonical form. Everything else needs the user to add
            // their own argument, so we append a trailing space.
            input.value = entry.cmd === '/explain' ? '/explain unverified' : entry.cmd + ' ';
            popup.style.display = 'none';
            input.placeholder = entry.example;
            input.focus();
            // Move caret to end so the user can type their arg immediately.
            try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
          }
          function refreshPlaceholder() {
            var entry = commandFor(input.value);
            input.placeholder = entry ? entry.example : DEFAULT_PLACEHOLDER;
          }

          input.addEventListener('input', function () {
            activeIdx = 0;
            renderPopup(filterList(input.value));
            refreshPlaceholder();
          });
          input.addEventListener('focus', function () {
            var items = filterList(input.value);
            if (items.length) renderPopup(items);
          });
          input.addEventListener('blur', function () {
            // Delay so an item mousedown still wins the race.
            setTimeout(function () { popup.style.display = 'none'; }, 120);
          });
          input.addEventListener('keydown', function (ev) {
            var items = filterList(input.value);
            var open = popup.style.display !== 'none' && items.length > 0;
            if (open && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
              ev.preventDefault();
              activeIdx = (activeIdx + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
              renderPopup(items);
              return;
            }
            if (open && ev.key === 'Tab') {
              ev.preventDefault();
              insertCommand(items[activeIdx].cmd);
              return;
            }
            if (ev.key === 'Escape') {
              popup.style.display = 'none';
              return;
            }
            if (ev.key !== 'Enter') return;
            // Enter while popup is open and the user has only typed a slash
            // prefix (no argument yet) means "accept the highlighted command";
            // otherwise Enter submits the full line.
            if (open) {
              ev.preventDefault();
              insertCommand(items[activeIdx].cmd);
              return;
            }
            ev.preventDefault();
            var v = input.value.trim();
            if (!v) return;
            send({ type: 'open_chat', prefill: v });
            input.value = '';
            input.placeholder = DEFAULT_PLACEHOLDER;
            popup.style.display = 'none';
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

        // --- minimap (real rendering; plan W5.3) ---
        // The mockup ships an empty <div class="minimap"> placeholder. We
        // mount a <canvas> inside it that mirrors cytoscape's world: each
        // node becomes a colored dot (bc color), the current viewport is a
        // hollow rectangle, and a click on the canvas pans cytoscape so the
        // clicked world point becomes the center.
        function initMinimap() {
          if (typeof cy === 'undefined') return false;
          var box = document.getElementById('minimap');
          if (!box) return false;
          // Don't double-init across re-layouts.
          if (box.querySelector('canvas')) return true;
          var W = box.clientWidth || 200;
          var H = box.clientHeight || 130;
          var canvas = document.createElement('canvas');
          canvas.width = W;
          canvas.height = H;
          canvas.style.position = 'absolute';
          canvas.style.inset = '0';
          canvas.style.width = W + 'px';
          canvas.style.height = H + 'px';
          canvas.style.cursor = 'crosshair';
          box.appendChild(canvas);
          var ctx = canvas.getContext('2d');
          if (!ctx) return true;

          // Resolve bc colors from the live mockup CSS so any theme change
          // here is reflected. Falls back to neutral grey on miss.
          var bcSwatchEl = {};
          ['host', 'capture', 'recall', 'shared'].forEach(function (slot) {
            var probe = document.querySelector('.chip.bc-chip[data-bc="' + slot + '"] .bc-marker');
            bcSwatchEl[slot] = probe ? getComputedStyle(probe).backgroundColor : '#888';
          });
          function colorForNode(n) {
            var c = n.data('classes') || '';
            var m = c.match(/bc-(host|capture|recall|shared|ext)/);
            if (!m) return '#888';
            if (m[1] === 'ext') return '#666';
            return bcSwatchEl[m[1]] || '#888';
          }

          function compute() {
            var nodes = cy.nodes().filter(function (n) { return n.style('display') !== 'none'; });
            if (nodes.length === 0) return null;
            var bb = nodes.boundingBox();
            var pad = 12;
            var bw = Math.max(1, bb.w + pad * 2);
            var bh = Math.max(1, bb.h + pad * 2);
            var scale = Math.min((W - 8) / bw, (H - 8) / bh);
            var offX = (W - bw * scale) / 2 - (bb.x1 - pad) * scale;
            var offY = (H - bh * scale) / 2 - (bb.y1 - pad) * scale;
            return { nodes: nodes, scale: scale, offX: offX, offY: offY };
          }

          function draw() {
            ctx.clearRect(0, 0, W, H);
            var f = compute();
            if (!f) return;
            // dots
            f.nodes.forEach(function (n) {
              var p = n.position();
              var x = p.x * f.scale + f.offX;
              var y = p.y * f.scale + f.offY;
              ctx.fillStyle = colorForNode(n);
              ctx.beginPath();
              ctx.arc(x, y, 2.2, 0, Math.PI * 2);
              ctx.fill();
            });
            // viewport rectangle
            var ext = cy.extent(); // {x1, y1, x2, y2}
            var rx = ext.x1 * f.scale + f.offX;
            var ry = ext.y1 * f.scale + f.offY;
            var rw = (ext.x2 - ext.x1) * f.scale;
            var rh = (ext.y2 - ext.y1) * f.scale;
            ctx.strokeStyle = 'rgba(120,200,255,0.85)';
            ctx.lineWidth = 1.2;
            ctx.strokeRect(rx, ry, rw, rh);
          }

          function panFromCanvas(ev) {
            var rect = canvas.getBoundingClientRect();
            var cx = ev.clientX - rect.left;
            var cy_ = ev.clientY - rect.top;
            var f = compute();
            if (!f) return;
            var wx = (cx - f.offX) / f.scale;
            var wy = (cy_ - f.offY) / f.scale;
            // Center cytoscape's viewport on (wx, wy).
            var z = cy.zoom();
            var Wc = cy.width(), Hc = cy.height();
            cy.pan({ x: Wc / 2 - wx * z, y: Hc / 2 - wy * z });
          }

          var dragging = false;
          canvas.addEventListener('mousedown', function (ev) { dragging = true; panFromCanvas(ev); });
          canvas.addEventListener('mousemove', function (ev) { if (dragging) panFromCanvas(ev); });
          canvas.addEventListener('mouseup', function () { dragging = false; });
          canvas.addEventListener('mouseleave', function () { dragging = false; });

          cy.on('viewport pan zoom layoutstop', draw);
          cy.on('style', function () { /* node display toggled by chips */ draw(); });
          // Throttled redraw on chip clicks too, since style events fire late.
          document.querySelectorAll('.chip').forEach(function (chip) {
            chip.addEventListener('click', function () { setTimeout(draw, 60); });
          });
          draw();
          return true;
        }

        // Initial pass once layout is ready. cytoscape's 'ready' fires on
        // page load; we also retry after a short delay in case the mockup's
        // own load handler runs later.
        function bootstrapAfterCy() {
          refineExternals();
          if (!initMinimap()) setTimeout(initMinimap, 120);
          if (!initZoomToolbar()) setTimeout(initZoomToolbar, 120);
        }
        if (typeof cy !== 'undefined') {
          bootstrapAfterCy();
        } else {
          window.addEventListener('load', function () { setTimeout(bootstrapAfterCy, 60); });
        }

        // --- zoom toolbar ---
        // Cytoscape's wheel zoom is configured in the layout block; this
        // adds discrete +/-/fit/1:1 buttons for users who want predictable
        // stepping rather than wheel-trackpad scrubbing. Step factor 1.2
        // matches "noticeable but not jarring" — VS Code's editor zoom uses
        // ~1.1, code maps benefit from a slightly larger step since cards
        // are bigger than glyphs.
        function initZoomToolbar() {
          if (typeof cy === 'undefined') return false;
          var host = document.getElementById('cy');
          if (!host) return false;
          if (document.getElementById('zoomToolbar')) return true;
          var bar = document.createElement('div');
          bar.id = 'zoomToolbar';
          bar.style.cssText = [
            'position:absolute',
            'left:14px',
            'bottom:14px',
            'display:flex',
            'gap:4px',
            'background:rgba(30,30,30,0.78)',
            'border:1px solid #3a3a3a',
            'border-radius:4px',
            'padding:3px',
            'z-index:5',
            'font-family:Segoe UI, sans-serif',
            'font-size:12px',
            'color:#cccccc',
          ].join(';');
          host.style.position = host.style.position || 'relative';

          function btn(label, title, handler) {
            var b = document.createElement('button');
            b.textContent = label;
            b.title = title;
            b.style.cssText = [
              'background:transparent',
              'border:none',
              'color:inherit',
              'font:inherit',
              'cursor:pointer',
              'padding:3px 8px',
              'border-radius:3px',
              'min-width:24px',
            ].join(';');
            b.addEventListener('mouseenter', function () { b.style.background = '#3a3a3a'; });
            b.addEventListener('mouseleave', function () { b.style.background = 'transparent'; });
            b.addEventListener('click', handler);
            return b;
          }

          function stepZoom(factor) {
            var z = cy.zoom();
            var ext = cy.extent();
            var cx = (ext.x1 + ext.x2) / 2;
            var cy2 = (ext.y1 + ext.y2) / 2;
            var rendered = { x: cy.width() / 2, y: cy.height() / 2 };
            cy.zoom({
              level: Math.max(0.15, Math.min(4, z * factor)),
              renderedPosition: rendered,
            });
          }

          bar.appendChild(btn('−', 'Zoom out', function () { stepZoom(1 / 1.2); }));
          bar.appendChild(btn('+', 'Zoom in', function () { stepZoom(1.2); }));
          bar.appendChild(btn('Fit', 'Fit graph to viewport', function () { cy.fit(undefined, 40); }));
          bar.appendChild(btn('1:1', 'Reset zoom to 100%', function () {
            cy.zoom(1);
            cy.center();
          }));

          // Separator between zoom controls and fold control. Two unrelated
          // groups of actions, keep them visually distinct.
          var sep = document.createElement('span');
          sep.style.cssText = 'width:1px;background:#3a3a3a;margin:2px 4px;';
          bar.appendChild(sep);

          // "Fold methods" toggles all class nodes between the full method
          // list and a compact ClassName + "(N methods)" header. Default is
          // expanded; clicking switches global state and the button label
          // reflects the next action.
          var foldBtn = btn('Fold', 'Hide method lists in graph nodes', function () {
            if (!window.__codemapCollapse) return;
            var nowCollapsed = window.__codemapCollapse.toggleAll();
            foldBtn.textContent = nowCollapsed ? 'Unfold' : 'Fold';
            foldBtn.title = nowCollapsed
              ? 'Show method lists in graph nodes'
              : 'Hide method lists in graph nodes';
          });
          bar.appendChild(foldBtn);

          host.appendChild(bar);
          return true;
        }
      })();
    </script>
  `;
  html = html.replace('</body>', `${postMockup}</body>`);

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src ${webview.cspSource} 'unsafe-inline' https:; style-src ${webview.cspSource} 'unsafe-inline' https:; connect-src https:;">`;
  html = html.replace('<head>', `<head>\n${cspMeta}`);
  return html;
}
