/**
 * Streaming parser for `codemap-meta` and `codemap-summary` blocks.
 *
 * The LLM emits multiple fenced JSON blocks; we feed text chunks in as they
 * arrive and yield parsed payloads. A block is only emitted once its closing
 * fence is seen, so a chunk boundary inside a JSON body is harmless.
 *
 * We tolerate (and silently skip):
 *   - JSON.parse errors (the block is dropped and a warning surfaces via the
 *     onError callback, if provided)
 *   - Unknown block tags
 *   - Prose between blocks (the contract forbids it but LLMs leak it)
 *
 * The shape of the parsed payload is intentionally loose (`unknown`) at the
 * parser layer — the calibrator does field-level validation. Mixing parse
 * with validation here would make recovery harder.
 */

export type RawBlock =
  | { kind: 'meta'; raw: string; data: unknown }
  | { kind: 'summary'; raw: string; data: unknown };

const OPEN_META = '```codemap-meta';
const OPEN_SUMMARY = '```codemap-summary';
const CLOSE = '```';

export interface ParseOptions {
  onError?: (err: { reason: string; raw: string }) => void;
}

export class CodemapMetaStreamParser {
  private buffer = '';

  constructor(private opts: ParseOptions = {}) {}

  /**
   * Feed a streamed text chunk. Returns any complete blocks that became
   * available with this chunk; an empty array if the chunk only extended an
   * open block.
   */
  feed(chunk: string): RawBlock[] {
    this.buffer += chunk;
    const out: RawBlock[] = [];

    while (true) {
      const next = this.findNextOpen(this.buffer);
      if (!next) break;
      const closeAt = this.buffer.indexOf(CLOSE, next.bodyStart);
      if (closeAt === -1) {
        // Block not closed yet; trim leading garbage but keep the open block.
        if (next.openStart > 0) {
          this.buffer = this.buffer.slice(next.openStart);
        }
        break;
      }
      const body = this.buffer.slice(next.bodyStart, closeAt).trim();
      this.buffer = this.buffer.slice(closeAt + CLOSE.length);

      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch (e) {
        this.opts.onError?.({ reason: `JSON parse failed: ${(e as Error).message}`, raw: body });
        continue;
      }

      out.push({ kind: next.kind, raw: body, data });
    }

    return out;
  }

  /**
   * Flush any partial buffer state at the end of the stream. Currently a
   * no-op for callers; we just discard a trailing unclosed block (with an
   * error callback). Tests rely on this method existing.
   */
  flush(): void {
    if (this.buffer.includes(OPEN_META) || this.buffer.includes(OPEN_SUMMARY)) {
      this.opts.onError?.({ reason: 'Unclosed block at end of stream', raw: this.buffer });
    }
    this.buffer = '';
  }

  private findNextOpen(buf: string):
    | { kind: 'meta' | 'summary'; openStart: number; bodyStart: number }
    | undefined {
    const meta = buf.indexOf(OPEN_META);
    const summary = buf.indexOf(OPEN_SUMMARY);
    if (meta === -1 && summary === -1) return undefined;
    if (meta === -1) {
      return { kind: 'summary', openStart: summary, bodyStart: summary + OPEN_SUMMARY.length };
    }
    if (summary === -1 || meta < summary) {
      return { kind: 'meta', openStart: meta, bodyStart: meta + OPEN_META.length };
    }
    return { kind: 'summary', openStart: summary, bodyStart: summary + OPEN_SUMMARY.length };
  }
}
