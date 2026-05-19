import * as vscode from 'vscode';
import { registerChatParticipant } from './chat/participant';
import { ReadingProgressStore } from './persistence/reading-progress';
import { GraphStore, currentWorkspaceRevHash } from './persistence/graph-store';
import { AnalyzerCache } from './persistence/analyzer-cache';
import { showGraph } from './webview/panel';

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
  // again. Filters by workspace revHash so we don't accidentally restore a
  // graph that belongs to a different folder.
  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.showLastGraph', async () => {
      const stored = new GraphStore(context.workspaceState).load(currentWorkspaceRevHash());
      if (!stored) {
        vscode.window.showInformationMessage(
          'CodeMap: no saved graph for this workspace yet. Run `@codemap generate codemap` first.',
        );
        return;
      }
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      await showGraph(
        context,
        stored.graph,
        stored.chatTurns,
        stored.stats,
        {
          repoName: workspaceFolder?.name ?? 'workspace',
          fileCountText: stored.stats?.filesAnalyzed
            ? `${stored.stats.filesAnalyzed} files analyzed`
            : '',
          scopePill: '📦 RESTORED',
        },
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
}

export function deactivate(): void {
  // no-op
}
