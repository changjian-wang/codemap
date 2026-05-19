import { describe, expect, it } from 'vitest';
import { normalizeScopePath } from '../../src/chat/scope';

const WS = 'C:\\github\\forks\\agent-framework';

describe('normalizeScopePath', () => {
  it('returns undefined for empty / whitespace', () => {
    expect(normalizeScopePath('', WS)).toBeUndefined();
    expect(normalizeScopePath('   ', WS)).toBeUndefined();
  });

  it('strips a workspace-root prefix from an absolute Windows path', () => {
    expect(
      normalizeScopePath('C:\\github\\forks\\agent-framework\\python\\packages', WS),
    ).toBe('python/packages');
  });

  it('returns empty string when the path equals the workspace root', () => {
    expect(normalizeScopePath('C:\\github\\forks\\agent-framework', WS)).toBe('');
    expect(normalizeScopePath('C:\\github\\forks\\agent-framework\\', WS)).toBe('');
  });

  it('returns undefined for absolute paths outside the workspace', () => {
    expect(normalizeScopePath('C:\\some\\other\\repo\\src', WS)).toBeUndefined();
  });

  it('is case-insensitive on Windows-style absolute paths', () => {
    expect(
      normalizeScopePath('c:\\GITHUB\\Forks\\agent-framework\\Python\\Packages', WS),
    ).toBe('Python/Packages');
  });

  it('returns relative paths unchanged (forward-slash form)', () => {
    expect(normalizeScopePath('python/packages/foo', WS)).toBe('python/packages/foo');
  });

  it('converts backslashes in a relative path to forward slashes', () => {
    expect(normalizeScopePath('dotnet\\src\\Foo', WS)).toBe('dotnet/src/Foo');
  });

  it('drops trailing slashes', () => {
    expect(normalizeScopePath('python/packages/foo/', WS)).toBe('python/packages/foo');
    expect(normalizeScopePath('python/packages/foo///', WS)).toBe('python/packages/foo');
  });

  it('handles posix-style absolute paths (non-Windows hosts)', () => {
    expect(normalizeScopePath('/home/me/proj/sub', '/home/me/proj')).toBe('sub');
    expect(normalizeScopePath('/home/me/proj', '/home/me/proj')).toBe('');
    expect(normalizeScopePath('/other/path', '/home/me/proj')).toBeUndefined();
  });
});
