import type * as vscode from 'vscode';

export type ChatIntentKind = 'generate_workspace' | 'scope' | 'focus' | 'why' | 'explain' | 'unknown';

export interface ChatIntent {
  kind: ChatIntentKind;
  /** Path for /scope, class name for /focus and /why, etc. */
  target?: string;
  /** Original prompt body. */
  prompt: string;
}

/**
 * Maps a {@link vscode.ChatRequest} to one of our internal intents.
 *
 * The slash-command syntax registered in package.json is the primary signal;
 * we fall back to keyword sniffing only when the user hits the participant
 * directly without a sub-command. We deliberately stay simple — the participant
 * doesn't try to LLM-parse intent in W1, that is a follow-up.
 */
export function routeChatIntent(request: vscode.ChatRequest): ChatIntent {
  const prompt = request.prompt.trim();

  switch (request.command) {
    case 'scope':
      return { kind: 'scope', target: prompt, prompt };
    case 'focus':
      return { kind: 'focus', target: prompt, prompt };
    case 'why':
      return { kind: 'why', target: prompt, prompt };
    case 'explain':
      return { kind: 'explain', target: prompt, prompt };
  }

  // No sub-command. If the prompt body mentions "codemap" / "graph" / "图" we
  // treat it as a workspace-level generation request; otherwise unknown.
  if (/codemap|call\s*graph|图谱|graph/i.test(prompt) || prompt.length === 0) {
    return { kind: 'generate_workspace', prompt };
  }
  return { kind: 'unknown', prompt };
}
