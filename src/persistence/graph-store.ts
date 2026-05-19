import * as vscode from 'vscode';
import type { CodeMapGraph } from '../shared/types';
import type { MockupChatTurn } from '../webview/graph-adapter';

const STATE_KEY = 'codemap.lastGraph';

/**
 * Persists the most recent {@link CodeMapGraph} in workspace state so chat
 * sub-commands (`/why`, `/explain`, `/focus`) and the WebView can keep working
 * across multiple chat turns and across window reloads.
 *
 * The stored payload is intentionally a flat record — `vscode.Memento`
 * round-trips structured-cloneable values, but keeping the surface narrow
 * makes it easy to migrate later (versioned key, multi-graph history, …).
 *
 * `revHash` is a string the caller supplies (typically the workspace folder
 * URI fsPath); it lets us discard a stale graph when the user opens a
 * different folder.
 */
export interface StoredGraph {
  graph: CodeMapGraph;
  chatTurns: MockupChatTurn[];
  /** Workspace identifier so we can drop graphs from other workspaces. */
  revHash: string;
  /** Unix ms when this graph was produced. */
  savedAt: number;
  /** Summary stats for inline rendering when restoring. */
  stats?: {
    verifiedCount: number;
    partialCount: number;
    unverifiedCount: number;
    filesAnalyzed: number;
    filesFailed: number;
    /**
     * Files served from the persistent analyzer cache (no LM call). Optional
     * because older stored graphs predate the cache and didn't track it.
     */
    filesFromCache?: number;
    durationMs: number;
  };
}

export class GraphStore {
  constructor(private state: vscode.Memento) {}

  async save(stored: StoredGraph): Promise<void> {
    await this.state.update(STATE_KEY, stored);
  }

  /** Returns the most recent graph if it was saved for the given workspace. */
  load(expectedRevHash?: string): StoredGraph | undefined {
    const v = this.state.get<StoredGraph>(STATE_KEY);
    if (!v) return undefined;
    if (expectedRevHash !== undefined && v.revHash !== expectedRevHash) return undefined;
    return v;
  }

  async clear(): Promise<void> {
    await this.state.update(STATE_KEY, undefined);
  }
}

/** Hash key for the current workspace — currently the first folder's fsPath. */
export function currentWorkspaceRevHash(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.fsPath : '<no-workspace>';
}
