import * as vscode from 'vscode';
import type { CodeMapGraph, CodeNode, MethodInfo } from '../shared/types';

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

/**
 * Overlay a persisted progress snapshot onto a graph, returning a new graph
 * with node/method `readState` flipped to `'read'` wherever the snapshot says
 * so. Pure — does not mutate the input graph.
 *
 * Used by the WebView panel to restore "mark as read" across reloads: the
 * orchestrator always emits fresh nodes with `readState: 'unread'`, but the
 * user's prior marks should still surface on the next render.
 */
export function applyReadingProgress(
  graph: CodeMapGraph,
  progress: ReadingProgress,
): CodeMapGraph {
  if (Object.keys(progress).length === 0) return graph;

  const nodes: Record<string, CodeNode> = {};
  for (const [id, node] of Object.entries(graph.nodes)) {
    const nodeRead = progress[`n:${id}`] === true;
    let methods: MethodInfo[] = node.methods;
    let methodsChanged = false;
    for (let i = 0; i < node.methods.length; i++) {
      const m = node.methods[i]!;
      const methodRead = progress[`m:${id}.${m.name}`] === true;
      const currentlyRead = m.readState === 'read';
      if (methodRead && !currentlyRead) {
        if (!methodsChanged) {
          methods = [...node.methods];
          methodsChanged = true;
        }
        methods[i] = { ...m, readState: 'read' };
      }
    }
    const wantsRead = nodeRead && node.readState !== 'read';
    if (wantsRead || methodsChanged) {
      nodes[id] = {
        ...node,
        ...(wantsRead ? { readState: 'read' as const } : {}),
        ...(methodsChanged ? { methods } : {}),
      };
    } else {
      nodes[id] = node;
    }
  }
  return { ...graph, nodes };
}
