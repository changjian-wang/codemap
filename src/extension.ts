import * as vscode from 'vscode';
import { registerChatParticipant } from './chat/participant';
import { ReadingProgressStore } from './persistence/reading-progress';

export function activate(context: vscode.ExtensionContext): void {
  // Chat Participant (@codemap) — primary entry point per v3 plan §5.2.
  context.subscriptions.push(registerChatParticipant(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('codemap.resetReadingProgress', async () => {
      await new ReadingProgressStore(context.workspaceState).reset();
      vscode.window.showInformationMessage('CodeMap reading progress reset.');
    }),
  );
}

export function deactivate(): void {
  // no-op
}
