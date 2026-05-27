import * as vscode from 'vscode';
import { registerChatParticipant } from './chat/participant';

// Phase 0.1 stub — see docs/adrs/005-renderer-rewrite-pixi.md
// and docs/plan/v4-plan.md. The old orchestrator/calibrator/webview
// stack lives under legacy/ and is no longer wired in.
const REBUILD_NOTICE =
  'CodeMap v0.1.0 is being rewritten (Pixi.js renderer + native-analyzer calibrators). ' +
  'See docs/plan/v4-plan.md for the slice roadmap.';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(registerChatParticipant(context));

  for (const id of [
    'codemap.resetReadingProgress',
    'codemap.showLastGraph',
    'codemap.clearAnalyzerCache',
    'codemap.saveCurrentGraphAsGolden',
  ]) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => {
        vscode.window.showInformationMessage(REBUILD_NOTICE);
      }),
    );
  }
}

export function deactivate(): void {
  // no-op
}
