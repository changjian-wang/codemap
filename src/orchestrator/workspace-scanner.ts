import * as path from 'path';

/**
 * Workspace scanner — picks the ≤ N "skeleton" files that the orchestrator
 * sends to the single-file analyzer.
 *
 * Strategy (v3 plan §4):
 *   1. Find entry points by file-name pattern (Program.cs, *Endpoints.cs,
 *      index.ts, Main.kt, …). We deliberately use cheap path matching over
 *      AST analysis — the scanner is a starting point, not the truth.
 *   2. BFS outward by parsing `using` / `import` / `require` statements,
 *      depth ≤ {@link ScanOptions.maxDepth}, file count ≤
 *      {@link ScanOptions.maxFiles}.
 *   3. Returned files are unique, in BFS order (entries first, then deeper
 *      layers), so a `slice(0, N)` always keeps the most "central" subset.
 *
 * Pure file IO via the workspace fs API → safe to test with the in-memory
 * `vscode-test` host, or to mock by passing a custom {@link FileReader}.
 */

export interface ScanOptions {
  maxDepth: number;
  maxFiles: number;
  /** Glob-ish extensions we care about. */
  extensions: string[];
  /**
   * Workspace-relative path prefix (forward slashes). When set, the scanner
   * only considers files whose path starts with this prefix as eligible.
   * This ensures the `maxFiles` cap is applied within the scope, not before
   * it (otherwise an out-of-scope entry-point heavy area can starve the
   * scope of skeleton slots).
   */
  pathPrefix?: string;
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  maxDepth: 3,
  maxFiles: 30,
  extensions: ['.cs', '.ts', '.tsx', '.js', '.jsx'],
};

/** File reader abstraction so tests can fake fs without spinning up vscode. */
export interface FileReader {
  /** Workspace-relative paths matching the given extensions. */
  listFiles(): Promise<string[]>;
  /** Read a file's text. Returns `undefined` if it doesn't exist. */
  readText(relPath: string): Promise<string | undefined>;
  /** Resolve a possibly-relative import target to a workspace-relative path. */
  resolveImport(fromRel: string, importTarget: string): Promise<string | undefined>;
}

export interface ScanResult {
  entryPoints: string[];
  skeleton: string[];
  /** Files we found but did not include due to {@link ScanOptions.maxFiles}. */
  overflow: string[];
}

const ENTRY_PATTERNS: RegExp[] = [
  /(?:^|[\/\\])Program\.cs$/i,
  /(?:^|[\/\\])Main\.(?:cs|kt|java)$/i,
  /(?:^|[\/\\])[A-Z]\w*Endpoints\.cs$/,
  /(?:^|[\/\\])[A-Z]\w*Controller\.cs$/,
  /(?:^|[\/\\])index\.(?:ts|tsx|js|jsx)$/i,
  /(?:^|[\/\\])main\.(?:ts|tsx|js|jsx)$/i,
  /(?:^|[\/\\])app\.(?:ts|tsx|js|jsx)$/i,
];

const CSHARP_USING_RE = /(?:^|;|\n)\s*using\s+([A-Za-z_][\w.]*)\s*;/g;
const TS_IMPORT_RE = /\bimport\s+(?:[\w*{}\s,]+from\s+)?['"]([^'"]+)['"]/g;
const TS_REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

export function isEntryPoint(relPath: string): boolean {
  return ENTRY_PATTERNS.some(r => r.test(relPath));
}

/** Extract raw import targets from a source file. */
export function extractImports(text: string, ext: string): string[] {
  const out = new Set<string>();
  if (ext === '.cs') {
    for (const m of text.matchAll(CSHARP_USING_RE)) out.add(m[1]!);
  } else if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    for (const m of text.matchAll(TS_IMPORT_RE)) out.add(m[1]!);
    for (const m of text.matchAll(TS_REQUIRE_RE)) out.add(m[1]!);
  }
  return [...out];
}

export async function scanWorkspace(
  reader: FileReader,
  options: ScanOptions = DEFAULT_SCAN_OPTIONS,
): Promise<ScanResult> {
  const allFiles = await reader.listFiles();
  const extOk = (f: string) =>
    options.extensions.some(ext => f.toLowerCase().endsWith(ext));
  const prefix = options.pathPrefix?.replace(/\\/g, '/').replace(/\/+$/, '') ?? '';
  const inScope = (f: string) =>
    !prefix || f === prefix || f.startsWith(prefix + '/');
  const eligible = allFiles.filter(f => extOk(f) && inScope(f));

  const entryPoints = eligible.filter(isEntryPoint);

  // Stable ordering: entries first by category strength (Program.cs >
  // *Endpoints.cs > index.ts), then by shorter path (closer to root).
  entryPoints.sort((a, b) => {
    const ai = ENTRY_PATTERNS.findIndex(r => r.test(a));
    const bi = ENTRY_PATTERNS.findIndex(r => r.test(b));
    if (ai !== bi) return ai - bi;
    return a.length - b.length;
  });

  // When a scope is set but it contains no recognized entry-points, fall
  // back to seeding BFS with the eligible files themselves (shortest path
  // first). Without this, scoping to e.g. `dotnet/src/Microsoft.Agents.AI`
  // — which is a library, not an app — yields an empty skeleton even
  // though there are plenty of analyzable .cs files.
  const seeds = entryPoints.length > 0
    ? entryPoints
    : prefix
      ? [...eligible].sort((a, b) => a.length - b.length)
      : [];

  const skeleton: string[] = [];
  const seen = new Set<string>();
  const queue: { file: string; depth: number }[] = seeds.map(f => ({ file: f, depth: 0 }));

  while (queue.length > 0 && skeleton.length < options.maxFiles) {
    const { file, depth } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    skeleton.push(file);

    if (depth >= options.maxDepth) continue;

    const text = await reader.readText(file);
    if (!text) continue;
    const ext = path.extname(file).toLowerCase();
    const targets = extractImports(text, ext);

    for (const t of targets) {
      const resolved = await reader.resolveImport(file, t);
      if (!resolved) continue;
      if (seen.has(resolved)) continue;
      // Only enqueue files in our eligible set — keeps us inside workspace
      // and inside the languages we know how to analyze.
      if (!eligible.includes(resolved)) continue;
      queue.push({ file: resolved, depth: depth + 1 });
    }
  }

  const overflow = eligible.filter(f => !seen.has(f) && !skeleton.includes(f));
  return { entryPoints, skeleton, overflow };
}

