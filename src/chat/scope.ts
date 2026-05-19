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
