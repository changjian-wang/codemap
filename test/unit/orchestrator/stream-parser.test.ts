// Phase 3.1 -- FencedBlockParser unit tests.

import { describe, expect, it } from 'vitest';
import { FencedBlockParser, type ParseError } from '../../../src/orchestrator/stream-parser';

function collect(parser: FencedBlockParser, chunks: string[]) {
  const out: ReturnType<FencedBlockParser['feed']> = [];
  for (const c of chunks) {
    out.push(...parser.feed(c));
  }
  parser.flush();
  return out;
}

describe('FencedBlockParser', () => {
  it('parses one meta block delivered in a single chunk', () => {
    const parser = new FencedBlockParser();
    const blocks = collect(parser, [
      '```codemap-meta\n{ "classes": [], "methods": [] }\n```',
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('meta');
    expect(blocks[0].data).toEqual({ classes: [], methods: [] });
  });

  it('parses meta + summary blocks in order', () => {
    const parser = new FencedBlockParser();
    const blocks = collect(parser, [
      '```codemap-meta\n{"classes":[],"methods":[]}\n```\n\n',
      '```codemap-summary\n{"rootIntent":"test"}\n```',
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['meta', 'summary']);
    expect(blocks[1].data).toEqual({ rootIntent: 'test' });
  });

  it('tolerates chunk boundaries inside fence open, body, and close', () => {
    const parser = new FencedBlockParser();
    const full = '```codemap-meta\n{"classes":[],"methods":[]}\n```';
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += 3) {
      chunks.push(full.slice(i, i + 3));
    }
    const blocks = collect(parser, chunks);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('meta');
  });

  it('silently drops prose between blocks', () => {
    const parser = new FencedBlockParser();
    const blocks = collect(parser, [
      'Sure, here you go:\n',
      '```codemap-meta\n{"classes":[],"methods":[]}\n```\n',
      'And the summary:\n',
      '```codemap-summary\n{"narrative":"x"}\n```',
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].data).toEqual({ narrative: 'x' });
  });

  it('emits onError for malformed JSON, then continues with the next block', () => {
    const errors: ParseError[] = [];
    const parser = new FencedBlockParser({ onError: (e) => errors.push(e) });
    const blocks = collect(parser, [
      '```codemap-meta\n{ not json }\n```\n',
      '```codemap-summary\n{"rootIntent":"ok"}\n```',
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('summary');
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(/JSON parse failed/);
  });

  it('emits onError when stream ends with an unclosed block', () => {
    const errors: ParseError[] = [];
    const parser = new FencedBlockParser({ onError: (e) => errors.push(e) });
    parser.feed('```codemap-meta\n{ "classes": []');
    parser.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(/Unclosed/);
  });

  it('treats a second meta block as a separate emission', () => {
    const parser = new FencedBlockParser();
    const blocks = collect(parser, [
      '```codemap-meta\n{"classes":[],"methods":[]}\n```',
      '```codemap-meta\n{"classes":[{"x":1}],"methods":[]}\n```',
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('meta');
    expect(blocks[1].kind).toBe('meta');
  });
});
