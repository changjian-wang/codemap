// Phase 3.1 -- fenced JSON block parser.
//
// The analyzer prompt instructs the LLM to emit two fenced blocks:
//
//   ```codemap-meta
//   { "classes": [...], "methods": [...] }
//   ```
//
//   ```codemap-summary
//   { "rootIntent": "...", "narrative": "..." }
//   ```
//
// We feed text chunks in as they arrive (so the parser is reusable for
// future streamed-to-webview flows) and yield complete blocks. Prose
// between fences is silently dropped: the protocol forbids it but LLMs
// leak it. JSON.parse errors are surfaced via onError without throwing
// so the analyzer can still keep whatever blocks DID parse.

export type FencedBlockKind = 'meta' | 'summary';

export interface FencedBlock {
  kind: FencedBlockKind;
  raw: string;
  data: unknown;
}

export interface ParseError {
  reason: string;
  raw: string;
}

export interface FencedBlockParserOptions {
  onError?: (err: ParseError) => void;
}

const OPEN_META = '```codemap-meta';
const OPEN_SUMMARY = '```codemap-summary';
const CLOSE = '```';

export class FencedBlockParser {
  private buffer = '';
  private readonly opts: FencedBlockParserOptions;

  constructor(opts: FencedBlockParserOptions = {}) {
    this.opts = opts;
  }

  /** Feed a streamed chunk; returns any complete blocks now available. */
  feed(chunk: string): FencedBlock[] {
    this.buffer += chunk;
    const out: FencedBlock[] = [];

    while (true) {
      const next = this.findNextOpen(this.buffer);
      if (!next) {
        break;
      }
      const closeAt = this.buffer.indexOf(CLOSE, next.bodyStart);
      if (closeAt === -1) {
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
        this.opts.onError?.({
          reason: `JSON parse failed: ${(e as Error).message}`,
          raw: body,
        });
        continue;
      }
      out.push({ kind: next.kind, raw: body, data });
    }
    return out;
  }

  /** Drain any unclosed block at end of stream. Reports via onError. */
  flush(): void {
    if (this.buffer.includes(OPEN_META) || this.buffer.includes(OPEN_SUMMARY)) {
      this.opts.onError?.({
        reason: 'Unclosed fenced block at end of stream',
        raw: this.buffer,
      });
    }
    this.buffer = '';
  }

  private findNextOpen(
    buf: string
  ): { kind: FencedBlockKind; openStart: number; bodyStart: number } | undefined {
    const meta = buf.indexOf(OPEN_META);
    const summary = buf.indexOf(OPEN_SUMMARY);
    if (meta === -1 && summary === -1) {
      return undefined;
    }
    if (meta === -1) {
      return {
        kind: 'summary',
        openStart: summary,
        bodyStart: summary + OPEN_SUMMARY.length,
      };
    }
    if (summary === -1 || meta < summary) {
      return {
        kind: 'meta',
        openStart: meta,
        bodyStart: meta + OPEN_META.length,
      };
    }
    return {
      kind: 'summary',
      openStart: summary,
      bodyStart: summary + OPEN_SUMMARY.length,
    };
  }
}
