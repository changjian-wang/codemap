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
 * Splits a slash-command argument into target + trailing prose.
 *   `/scope path/to/dir generate codemap`  -> target='path/to/dir', rest='generate codemap'
 *   `/scope "C:\\path with space\\sub" go` -> target='C:\\path with space\\sub', rest='go'
 * Used so users can append free-form notes after the actual target.
 */
export function splitFirstToken(raw: string): { target: string; rest: string } {
  const s = raw.trim();
  if (!s) return { target: '', rest: '' };
  if (s.startsWith('"') || s.startsWith("'")) {
    const quote = s[0];
    const end = s.indexOf(quote, 1);
    if (end > 0) {
      return { target: s.slice(1, end), rest: s.slice(end + 1).trim() };
    }
  }
  const m = s.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (m) return { target: m[1]!, rest: (m[2] ?? '').trim() };
  return { target: s, rest: '' };
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
    case 'scope': {
      const { target } = splitFirstToken(prompt);
      return { kind: 'scope', target, prompt };
    }
    case 'focus': {
      const { target } = splitFirstToken(prompt);
      return { kind: 'focus', target, prompt };
    }
    case 'why': {
      const { target } = splitFirstToken(prompt);
      return { kind: 'why', target, prompt };
    }
    case 'explain':
      return { kind: 'explain', target: prompt, prompt };
  }

  // No sub-command. If the prompt body mentions codemap / call graph / graph
  // we treat it as a workspace-level generation request; otherwise unknown.
  if (/codemap|call\s*graph|graph/i.test(prompt) || prompt.length === 0) {
    return { kind: 'generate_workspace', prompt };
  }
  return { kind: 'unknown', prompt };
}
