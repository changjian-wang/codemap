import { describe, expect, it } from 'vitest';
import { normalizeScopePath, resolveScope } from '../../src/chat/scope';

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

describe('resolveScope (multi-root)', () => {
  const folders = [
    { name: 'dawning', uri: { fsPath: 'C:\\github\\dawning' } },
    { name: 'lumen',   uri: { fsPath: 'C:\\github\\lumen' } },
    { name: 'codemap', uri: { fsPath: 'C:\\github\\codemap' } },
  ];

  it('picks the matching folder when an absolute path lives in a non-first root', () => {
    const r = resolveScope('C:\\github\\lumen\\apps\\api\\src', folders);
    expect(r?.folder.name).toBe('lumen');
    expect(r?.prefix).toBe('apps/api/src');
  });

  it('returns undefined when an absolute path is outside every root', () => {
    expect(resolveScope('C:\\some\\other\\repo', folders)).toBeUndefined();
  });

  it('resolves `<folderName>/<sub>` relative form to that folder', () => {
    const r = resolveScope('lumen/apps/api/src', folders);
    expect(r?.folder.name).toBe('lumen');
    expect(r?.prefix).toBe('apps/api/src');
  });

  it('matches folder name case-insensitively', () => {
    const r = resolveScope('LUMEN/apps', folders);
    expect(r?.folder.name).toBe('lumen');
    expect(r?.prefix).toBe('apps');
  });

  it('falls back to the first folder for a bare relative path when single-root', () => {
    const single = [{ name: 'dawning', uri: { fsPath: 'C:\\github\\dawning' } }];
    const r = resolveScope('apps/api/src', single);
    expect(r?.folder.name).toBe('dawning');
    expect(r?.prefix).toBe('apps/api/src');
  });

  it('refuses bare relative paths in multi-root workspaces (ambiguous)', () => {
    expect(resolveScope('apps/api/src', folders)).toBeUndefined();
  });

  it('returns empty prefix when the path equals a folder root', () => {
    const r = resolveScope('C:\\github\\lumen', folders);
    expect(r?.folder.name).toBe('lumen');
    expect(r?.prefix).toBe('');
  });

  it('returns undefined for empty input', () => {
    expect(resolveScope('', folders)).toBeUndefined();
    expect(resolveScope('   ', folders)).toBeUndefined();
  });
});
