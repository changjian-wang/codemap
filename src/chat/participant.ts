import * as vscode from 'vscode';
import { routeChatIntent } from './intent-router';
import { showDemoGraph } from '../webview/panel';

const PARTICIPANT_ID = 'codemap.codemap';

export function registerChatParticipant(context: vscode.ExtensionContext): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, _chatContext, response, token) => {
    const intent = routeChatIntent(request);

    response.markdown(`👋 received intent: \`${intent.kind}\`.\n\n`);

    if (token.isCancellationRequested) return;

    // W1 stub: any request opens the demo graph and reports progress. The
    // real orchestrator (W2-W3) replaces this branch.
    switch (intent.kind) {
      case 'generate_workspace':
      case 'scope':
      case 'focus':
        response.progress('Loading fixture demo graph (orchestrator pending W2-W3)…');
        await showDemoGraph(context);
        response.markdown(
          '\n\nDemo graph opened in the WebView panel. Replace this branch with the real orchestrator in W2-W3.',
        );
        break;
      case 'why':
      case 'explain':
        response.markdown(
          intent.kind === 'why'
            ? `Stub: would explain why \`${intent.target ?? '(no target)'}\` is partial/unverified.`
            : 'Stub: would list all unverified nodes and their reasons.',
        );
        break;
      case 'unknown':
        response.markdown(
          'I did not recognize that command. Try: `@codemap generate workspace codemap`, `/scope <path>`, `/focus <Class>`, `/why <Class>`, `/explain unverified`.',
        );
        break;
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon('graph');
  return participant;
}
