import * as vscode from 'vscode';
import type { CodeMapGraph } from '../shared/types';
import type { MockupChatTurn } from '../webview/graph-adapter';

const STATE_KEY_PREFIX = 'codemap.lastGraph';
// Legacy single-key storage from before multi-root support. We read it once
// (when no per-root entry exists) to migrate users who already had a graph
// saved in a single-root workspace.
const LEGACY_STATE_KEY = 'codemap.lastGraph';

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
    /** Score against the workspace's golden, if one exists. Lets the next
     *  generate run flag regression vs this baseline without re-running the
     *  comparison from scratch. */
    eval?: {
      nodes: { precision: number; recall: number; f1: number };
      edges: { precision: number; recall: number; f1: number };
    };
  };
}

function keyForFolder(folderFsPath: string): string {
  return `${STATE_KEY_PREFIX}:${folderFsPath}`;
}

export class GraphStore {
  /**
   * @param state    The workspaceState memento.
   * @param folder   The workspace folder this store is scoped to. Required
   *                 for save/clear; load falls back to legacy single-key
   *                 storage when no per-root entry exists yet.
   */
  constructor(private state: vscode.Memento, private folder?: vscode.Uri) {}

  private get key(): string {
    return this.folder
      ? keyForFolder(this.folder.fsPath)
      : LEGACY_STATE_KEY;
  }

  async save(stored: StoredGraph): Promise<void> {
    await this.state.update(this.key, stored);
  }

  /**
   * Returns the most recent graph for this store's folder. Falls back to the
   * legacy single-key storage so users with a graph saved before the
   * multi-root migration still see it on the first reload.
   */
  load(expectedRevHash?: string): StoredGraph | undefined {
    let v = this.state.get<StoredGraph>(this.key);
    if (!v && this.folder) {
      // One-time fallback: read the legacy single-key entry. This means
      // single-root workspaces don't lose their saved graph on upgrade.
      const legacy = this.state.get<StoredGraph>(LEGACY_STATE_KEY);
      if (legacy && legacy.revHash === this.folder.fsPath) v = legacy;
    }
    if (!v) return undefined;
    if (expectedRevHash !== undefined && v.revHash !== expectedRevHash) return undefined;
    return v;
  }

  async clear(): Promise<void> {
    await this.state.update(this.key, undefined);
  }
}

/**
 * Finds the most recently saved graph across any workspace folder. Used by
 * `/why`, `/explain`, `/focus` and the `Show Last Graph` command — these
 * have no scope argument, so the right answer is "whatever the user most
 * recently analyzed".
 */
export function loadLatestGraph(
  state: vscode.Memento,
  folders: readonly vscode.WorkspaceFolder[] | undefined,
): { stored: StoredGraph; folder: vscode.WorkspaceFolder | undefined } | undefined {
  let best: { stored: StoredGraph; folder: vscode.WorkspaceFolder | undefined } | undefined;
  if (folders) {
    for (const f of folders) {
      const v = state.get<StoredGraph>(keyForFolder(f.uri.fsPath));
      if (!v) continue;
      if (!best || v.savedAt > best.stored.savedAt) best = { stored: v, folder: f };
    }
  }
  // Legacy fallback only when no per-root entry exists.
  if (!best) {
    const legacy = state.get<StoredGraph>(LEGACY_STATE_KEY);
    if (legacy) {
      const matchingFolder = folders?.find(f => f.uri.fsPath === legacy.revHash);
      best = { stored: legacy, folder: matchingFolder };
    }
  }
  return best;
}

/** Hash key for a workspace folder. Defaults to the first folder when none
 *  is given (legacy single-root call sites). */
export function currentWorkspaceRevHash(folder?: vscode.WorkspaceFolder): string {
  const f = folder ?? vscode.workspace.workspaceFolders?.[0];
  return f ? f.uri.fsPath : '<no-workspace>';
}
