import { createHash } from 'crypto';
import type * as vscode from 'vscode';
import type { AnalyzeResult } from '../orchestrator/single-file-analyzer';

/**
 * Per-file LLM analyzer cache.
 *
 * The single-file analyzer is the dominant cost (LLM call per skeleton
 * file). We key cached {@link AnalyzeResult} on `(prompt_version, file,
 * fileText)` so that re-running `@codemap` over a workspace where only a
 * handful of files changed reuses prior LLM output instead of re-billing
 * every file.
 *
 * Storage: a single workspaceState record under one key — the whole map
 * is read once at orchestrator start and written back when entries change.
 * Eviction: LRU by `lastUsed` once we exceed `maxEntries`.
 */
const STATE_KEY = 'codemap.analyzerCache.v1';

interface CacheEntry {
  key: string;
  result: AnalyzeResult;
  /** Unix ms — used for LRU eviction. */
  lastUsed: number;
}

interface CacheRecord {
  entries: CacheEntry[];
}

export class AnalyzerCache {
  private current: CacheRecord;
  /**
   * Monotonic LRU counter. We can't rely on `Date.now()` because four
   * `set()` calls inside a single test tick produce identical timestamps,
   * making sort order non-deterministic and breaking LRU eviction.
   *
   * The counter starts from the max `lastUsed` we read from persisted
   * state, so survives reloads without conflict.
   */
  private nextTick: number;
  /** In-memory dedup so we coalesce concurrent writes within a single run. */
  private pendingWrite: Promise<void> | null = null;

  constructor(
    private state: vscode.Memento,
    private maxEntries = 400,
  ) {
    const raw = state.get<CacheRecord>(STATE_KEY);
    this.current = raw && Array.isArray(raw.entries) ? raw : { entries: [] };
    this.nextTick =
      this.current.entries.reduce((m, e) => Math.max(m, e.lastUsed ?? 0), 0) + 1;
  }

  /**
   * Compute the cache key. Combines prompt version + file path + content
   * sha. We include the path because `AnalyzeResult.file` records it and
   * downstream graph node ids are stable per-path; re-using the same blob
   * under a different path would silently emit edges pointing at the old
   * location.
   */
  static key(promptVersion: string, file: string, fileText: string): string {
    return createHash('sha256')
      .update(promptVersion)
      .update('\0')
      .update(file)
      .update('\0')
      .update(fileText)
      .digest('hex');
  }

  get(key: string): AnalyzeResult | undefined {
    const hit = this.current.entries.find((e) => e.key === key);
    if (!hit) return undefined;
    hit.lastUsed = this.nextTick++;
    // Best-effort write; not awaited — the next `set` will flush.
    void this.scheduleWrite();
    return hit.result;
  }

  async set(key: string, result: AnalyzeResult): Promise<void> {
    const existingIdx = this.current.entries.findIndex((e) => e.key === key);
    const entry: CacheEntry = { key, result, lastUsed: this.nextTick++ };
    if (existingIdx >= 0) {
      this.current.entries[existingIdx] = entry;
    } else {
      this.current.entries.push(entry);
    }
    // LRU evict.
    if (this.current.entries.length > this.maxEntries) {
      this.current.entries.sort((a, b) => b.lastUsed - a.lastUsed);
      this.current.entries.length = this.maxEntries;
    }
    await this.scheduleWrite();
  }

  size(): number {
    return this.current.entries.length;
  }

  async clear(): Promise<void> {
    this.current = { entries: [] };
    await this.state.update(STATE_KEY, undefined);
  }

  private scheduleWrite(): Promise<void> {
    if (this.pendingWrite) return this.pendingWrite;
    this.pendingWrite = Promise.resolve().then(async () => {
      try {
        await this.state.update(STATE_KEY, this.current);
      } finally {
        this.pendingWrite = null;
      }
    });
    return this.pendingWrite;
  }
}
