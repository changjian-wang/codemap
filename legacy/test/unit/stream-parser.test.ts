import { describe, it, expect, vi } from 'vitest';
import { CodemapMetaStreamParser } from '../../src/llm/stream-parser';

describe('CodemapMetaStreamParser', () => {
  const META = '```codemap-meta\n{"node_id":"Foo","intent":"x"}\n```';
  const SUMMARY = '```codemap-summary\n{"root_intent":"y"}\n```';

  it('parses one block fed in a single chunk', () => {
    const p = new CodemapMetaStreamParser();
    const out = p.feed(META);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('meta');
    expect(out[0]!.data).toEqual({ node_id: 'Foo', intent: 'x' });
  });

  it('handles a block split across chunks', () => {
    const p = new CodemapMetaStreamParser();
    expect(p.feed('```codemap-meta\n{"node_')).toEqual([]);
    expect(p.feed('id":"Foo","intent":"x"}')).toEqual([]);
    const out = p.feed('\n```');
    expect(out).toHaveLength(1);
    expect(out[0]!.data).toEqual({ node_id: 'Foo', intent: 'x' });
  });

  it('parses meta + summary in order', () => {
    const p = new CodemapMetaStreamParser();
    const out = p.feed(`${META}\n\n${SUMMARY}`);
    expect(out.map(b => b.kind)).toEqual(['meta', 'summary']);
  });

  it('skips prose between blocks', () => {
    const p = new CodemapMetaStreamParser();
    const out = p.feed(`Hello world\n${META}\n\nignore me\n${SUMMARY}`);
    expect(out).toHaveLength(2);
  });

  it('drops malformed JSON and reports via onError', () => {
    const onError = vi.fn();
    const p = new CodemapMetaStreamParser({ onError });
    const out = p.feed('```codemap-meta\n{not json}\n```');
    expect(out).toEqual([]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]!.reason).toMatch(/JSON parse failed/);
  });

  it('resumes after a malformed block', () => {
    const p = new CodemapMetaStreamParser({ onError: () => {} });
    const out = p.feed(
      '```codemap-meta\n{broken}\n```\n```codemap-meta\n{"node_id":"OK"}\n```',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.data).toEqual({ node_id: 'OK' });
  });

  it('flush reports an unclosed block', () => {
    const onError = vi.fn();
    const p = new CodemapMetaStreamParser({ onError });
    p.feed('```codemap-meta\n{"node_id":"Half"');
    p.flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]!.reason).toMatch(/Unclosed/);
  });

  it('flush is a no-op when buffer is empty', () => {
    const onError = vi.fn();
    const p = new CodemapMetaStreamParser({ onError });
    p.feed(META);
    p.flush();
    expect(onError).not.toHaveBeenCalled();
  });

  it('handles many small chunks (1 char at a time)', () => {
    const p = new CodemapMetaStreamParser();
    const blocks: ReturnType<typeof p.feed> = [];
    for (const ch of `${META}\n${SUMMARY}`) {
      blocks.push(...p.feed(ch));
    }
    expect(blocks).toHaveLength(2);
    expect(blocks.map(b => b.kind)).toEqual(['meta', 'summary']);
  });
});
