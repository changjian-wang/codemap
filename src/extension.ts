import * as vscode from 'vscode';
import * as path from 'path';
import { registerChatParticipant } from './chat/participant';
import { ReadingProgressStore } from './persistence/reading-progress';
import { loadLatestGraph } from './persistence/graph-store';
import { AnalyzerCache } from './persistence/analyzer-cache';
import { showGraph } from './webview/panel';
import { graphToGolden, stringifyGolden } from './eval/golden-writer';

export function activate(context: vscode.ExtensionContext): void {
  // Chat Participant (@codemap) — primary entry point per v3 plan §5.2.
  context.subscriptions.push(registerChatParticipant(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.resetReadingProgress', async () => {
      await new ReadingProgressStore(context.workspaceState).reset();
      vscode.window.showInformationMessage('CodeMap reading progress reset.');
    }),
  );

  // Re-open the most recently generated graph without paying the LM cost
  // again. In multi-root workspaces, picks whichever root has the freshest
  // saved graph.
  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.showLastGraph', async () => {
      const latest = loadLatestGraph(context.workspaceState, vscode.workspace.workspaceFolders);
      if (!latest) {
        vscode.window.showInformationMessage(
          'CodeMap: no saved graph for this workspace yet. Run `@codemap generate codemap` first.',
        );
        return;
      }
      const { stored, folder } = latest;
      await showGraph(
        context,
        stored.graph,
        stored.chatTurns,
        stored.stats,
        {
          repoName: folder?.name ?? 'workspace',
          fileCountText: stored.stats?.filesAnalyzed
            ? `${stored.stats.filesAnalyzed} files analyzed`
            : '',
          scopePill: '📦 RESTORED',
        },
        folder?.uri,
      );
    }),
  );

  // Power-user escape hatch when the cache holds stale results (e.g. the
  // prompt changed without bumping PROMPT_VERSION during development).
  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.clearAnalyzerCache', async () => {
      await new AnalyzerCache(context.workspaceState).clear();
      vscode.window.showInformationMessage('CodeMap analyzer cache cleared.');
    }),
  );

  // Snapshot the most recent graph into `<folder>/.codemap/golden.json`.
  // Lets the user pin "this is what I expect the analyzer to produce" so
  // future runs surface regressions via precision/recall scores instead of
  // a vibes-based feeling that something changed.
  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.saveCurrentGraphAsGolden', async () => {
      const latest = loadLatestGraph(context.workspaceState, vscode.workspace.workspaceFolders);
      if (!latest) {
        vscode.window.showInformationMessage(
          'CodeMap: no saved graph available. Run `@codemap generate codemap` first.',
        );
        return;
      }
      const { stored, folder } = latest;
      if (!folder) {
        vscode.window.showWarningMessage(
          'CodeMap: graph has no associated workspace folder; cannot write golden file.',
        );
        return;
      }
      const defaultName = stored.graph.scope || folder.name || 'workspace';
      const name = await vscode.window.showInputBox({
        title: 'Save as golden — name',
        prompt: 'Short identifier embedded in the file (used in eval reports).',
        value: defaultName,
      });
      if (!name) return;
      const description = await vscode.window.showInputBox({
        title: 'Save as golden — description (optional)',
        prompt: 'Why this baseline matters (e.g. "v0.0.1 baseline after marker filter").',
        placeHolder: 'optional',
      });

      // Default the scopeFiles to the current scope prefix when present so
      // future evals don't penalise the analyzer for picking up extra files
      // outside the scope the user originally asked for.
      const scopePrefix =
        stored.graph.scope && stored.graph.scope !== 'workspace' && !stored.graph.scope.startsWith('focus:')
          ? [stored.graph.scope]
          : undefined;

      const golden = graphToGolden(stored.graph, {
        name,
        description: description || undefined,
        scopeFiles: scopePrefix,
      });
      const goldenUri = vscode.Uri.joinPath(folder.uri, '.codemap', 'golden.json');
      try {
        // Ensure .codemap/ exists; vscode.workspace.fs.createDirectory is
        // a no-op when the directory already exists.
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.codemap'));
        const existing = await vscode.workspace.fs.stat(goldenUri).then(() => true, () => false);
        if (existing) {
          const overwrite = await vscode.window.showWarningMessage(
            `\`${path.posix.join(folder.name, '.codemap', 'golden.json')}\` already exists. Overwrite?`,
            { modal: true },
            'Overwrite',
          );
          if (overwrite !== 'Overwrite') return;
        }
        await vscode.workspace.fs.writeFile(
          goldenUri,
          Buffer.from(stringifyGolden(golden), 'utf8'),
        );
        const action = await vscode.window.showInformationMessage(
          `CodeMap golden saved: ${golden.nodes.length} nodes, ${golden.edges.length} edges.`,
          'Open file',
        );
        if (action === 'Open file') {
          const doc = await vscode.workspace.openTextDocument(goldenUri);
          await vscode.window.showTextDocument(doc);
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `CodeMap: failed to write golden file — ${(err as Error).message}`,
        );
      }
    }),
  );
}

export function deactivate(): void {
  // no-op
}
