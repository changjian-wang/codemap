import * as vscode from 'vscode';

/**
 * Per-workspace reading progress, keyed by node id (and optionally method
 * name). Persisted via {@link vscode.Memento} so it survives reloads.
 *
 * Key format:
 *   - node-level:    "n:<nodeId>"
 *   - method-level:  "m:<nodeId>.<method>"
 *
 * We store a flat record under a single Memento key (`codemap.readingProgress`)
 * so callers can wipe the whole thing in one update.
 */
const STATE_KEY = 'codemap.readingProgress';

export type ReadFlag = true;
export interface ReadingProgress {
  [key: string]: ReadFlag;
}

export class ReadingProgressStore {
  constructor(private state: vscode.Memento) {}

  private get current(): ReadingProgress {
    return this.state.get<ReadingProgress>(STATE_KEY, {});
  }

  private async write(next: ReadingProgress): Promise<void> {
    await this.state.update(STATE_KEY, next);
  }

  isNodeRead(nodeId: string): boolean {
    return this.current[`n:${nodeId}`] === true;
  }

  isMethodRead(nodeId: string, method: string): boolean {
    return this.current[`m:${nodeId}.${method}`] === true;
  }

  async setNodeRead(nodeId: string, read: boolean): Promise<void> {
    const next = { ...this.current };
    const key = `n:${nodeId}`;
    if (read) next[key] = true;
    else delete next[key];
    await this.write(next);
  }

  async setMethodRead(nodeId: string, method: string, read: boolean): Promise<void> {
    const next = { ...this.current };
    const key = `m:${nodeId}.${method}`;
    if (read) next[key] = true;
    else delete next[key];
    await this.write(next);
  }

  async reset(): Promise<void> {
    await this.state.update(STATE_KEY, undefined);
  }

  /** Copy-on-read snapshot, e.g. to send to the WebView. */
  snapshot(): ReadingProgress {
    return { ...this.current };
  }
}
