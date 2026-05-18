import * as vscode from 'vscode';
import { registerChatParticipant } from './chat/participant';
import { showDemoGraph } from './webview/panel';

export function activate(context: vscode.ExtensionContext): void {
  // Chat Participant (@codemap) — primary entry point per v3 plan §5.2.
  context.subscriptions.push(registerChatParticipant(context));

  // Fixture-driven demo, kept available throughout W1-W2 so the UI can be
  // iterated independently of the orchestrator.
  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.showDemoGraph', () => showDemoGraph(context)),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.resetReadingProgress', async () => {
      await context.workspaceState.update('codemap.readingProgress', undefined);
      vscode.window.showInformationMessage('CodeMap reading progress reset.');
    }),
  );
}

export function deactivate(): void {
  // no-op
}
