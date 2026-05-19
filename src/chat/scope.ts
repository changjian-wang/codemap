/**
 * Normalize a `/scope` argument into a workspace-relative path prefix that
 * the orchestrator can compare against scanner output (which is always
 * workspace-relative with `/` separators).
 *
 *   - backslashes → forward slashes
 *   - drop trailing slashes
 *   - if absolute and inside the workspace, strip the workspace root prefix
 *   - if absolute and outside the workspace, return `undefined` (caller warns)
 *
 * Case-insensitive matching on Windows (workspace root and target lower-cased
 * for the comparison) so users can paste either casing.
 *
 * Pure function on plain strings so it can be unit-tested without spinning
 * up vscode.
 */
export function normalizeScopePath(
  raw: string,
  workspaceFsPath: string,
): string | undefined {
  let s = raw.replace(/\\/g, '/').replace(/\/+$/, '').trim();
  if (!s) return undefined;
  if (/^[a-zA-Z]:\//.test(s) || s.startsWith('/')) {
    const wsPath = workspaceFsPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const sLower = s.toLowerCase();
    const wsLower = wsPath.toLowerCase();
    if (sLower === wsLower) return '';
    if (sLower.startsWith(wsLower + '/')) return s.slice(wsPath.length + 1);
    return undefined; // absolute path outside this workspace
  }
  return s;
}

/**
 * Multi-root aware resolution of a `/scope` argument.
 *
 * Tries every workspace folder, in order, and picks the first one that the
 * argument matches:
 *   1. absolute path inside a folder  → strip that folder's prefix
 *   2. relative path that starts with `<folderName>/` → strip the folder name
 *   3. relative path under the first folder (legacy fallback)
 *
 * Returns the matched folder + the relative prefix to feed the scanner, or
 * `undefined` when the argument doesn't match any folder. Empty `prefix` means
 * "the whole folder".
 */
export interface ScopeFolderLike {
  readonly name: string;
  readonly uri: { readonly fsPath: string };
}
export interface ResolvedScope<F extends ScopeFolderLike> {
  folder: F;
  prefix: string;
}
export function resolveScope<F extends ScopeFolderLike>(
  raw: string,
  folders: readonly F[],
): ResolvedScope<F> | undefined {
  if (folders.length === 0) return undefined;
  const s = raw.replace(/\\/g, '/').replace(/\/+$/, '').trim();
  if (!s) return undefined;

  const isAbsolute = /^[a-zA-Z]:\//.test(s) || s.startsWith('/');

  if (isAbsolute) {
    for (const folder of folders) {
      const prefix = normalizeScopePath(raw, folder.uri.fsPath);
      if (prefix !== undefined) return { folder, prefix };
    }
    return undefined;
  }

  // Relative form `<folderName>/<sub>` — only meaningful when there are
  // multiple roots or the user explicitly types the root name.
  const firstSeg = s.split('/', 1)[0]!;
  for (const folder of folders) {
    if (folder.name.toLowerCase() === firstSeg.toLowerCase()) {
      const rest = s.slice(firstSeg.length + 1); // safe: slice past `/` or empty
      return { folder, prefix: rest };
    }
  }

  // Legacy: bare relative path. Assume the first folder (matches the old
  // single-root behavior so existing prompts keep working).
  return { folder: folders[0]!, prefix: s };
}
