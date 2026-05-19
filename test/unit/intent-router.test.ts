import { describe, expect, it } from 'vitest';
import { splitFirstToken } from '../../src/chat/intent-router';

describe('splitFirstToken', () => {
  it('splits a bare path from trailing prose', () => {
    expect(splitFirstToken('python/packages/foo generate codemap')).toEqual({
      target: 'python/packages/foo',
      rest: 'generate codemap',
    });
  });

  it('returns target=path, rest="" when only a path is given', () => {
    expect(splitFirstToken('python/packages/foo')).toEqual({
      target: 'python/packages/foo',
      rest: '',
    });
  });

  it('handles empty input', () => {
    expect(splitFirstToken('')).toEqual({ target: '', rest: '' });
    expect(splitFirstToken('   ')).toEqual({ target: '', rest: '' });
  });

  it('respects double-quoted paths with spaces', () => {
    expect(splitFirstToken('"C:\\path with space\\sub" go')).toEqual({
      target: 'C:\\path with space\\sub',
      rest: 'go',
    });
  });

  it('respects single-quoted paths with spaces', () => {
    expect(splitFirstToken("'a b c' x y")).toEqual({ target: 'a b c', rest: 'x y' });
  });

  it('handles absolute Windows paths', () => {
    expect(
      splitFirstToken('C:\\github\\forks\\agent-framework\\python\\packages 生成codemap'),
    ).toEqual({
      target: 'C:\\github\\forks\\agent-framework\\python\\packages',
      rest: '生成codemap',
    });
  });

  it('preserves the path verbatim — no normalization at this layer', () => {
    // splitFirstToken is purely lexical; normalization happens in the
    // participant where we know the workspace root.
    expect(splitFirstToken('Foo\\Bar 123')).toEqual({ target: 'Foo\\Bar', rest: '123' });
  });
});
