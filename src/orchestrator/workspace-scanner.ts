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
  /**
   * Ranking strategy for the final {@link ScanResult.skeleton} slice:
   *
   *  - `'bfs'` (legacy): walk the import graph in BFS order, stop at
   *    `maxFiles`. Simple and deterministic; predictable for unit tests.
   *  - `'centrality'`: BFS-discover up to ~3× `maxFiles`, then score each
   *    discovered file by `entry-bonus + inDegree * 100 - depth * 10` and
   *    keep the top `maxFiles`. Produces more useful skeletons on large
   *    workspaces (e.g. `agent-framework`) where BFS would otherwise pick
   *    up many leaf utility modules instead of "real" service classes.
   *
   * Default `'bfs'` to keep existing tests deterministic. The orchestrator
   * passes `'centrality'` explicitly for the production code path.
   */
  rankBy?: 'bfs' | 'centrality';
  /**
   * After BFS+rerank, if the skeleton is still smaller than {@link maxFiles},
   * top it up with the remaining eligible files (shortest path first). This
   * is the practical fix for languages whose imports can't be resolved back
   * to files — C# `using` is a namespace, not a path, so BFS would otherwise
   * stop at the entry points and silently leave most of the project
   * un-analyzed.
   *
   * Default `false` so unit tests that pin BFS-cap semantics stay
   * deterministic; the orchestrator passes `true` explicitly.
   */
  fillToMaxFiles?: boolean;
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  maxDepth: 3,
  maxFiles: 30,
  extensions: ['.cs', '.ts', '.tsx', '.js', '.jsx', '.py'],
  rankBy: 'bfs',
};

/** File reader abstraction so tests can fake fs without spinning up vscode. */
export interface FileReader {
  /** Workspace-relative paths matching the given extensions. */
  listFiles(): Promise<string[]>;
  /** Read a file's text. Returns `undefined` if it doesn't exist. */
  readText(relPath: string): Promise<string | undefined>;
  /**
   * Resolve an import target to one or more workspace-relative files.
   *
   * Most languages bind a single import statement to a single file
   * (TS/JS/Py relative imports), so the array typically has 0 or 1 entry.
   * C# `using Foo.Bar` is the exception: a namespace is spread across
   * many sibling files (one class/interface per file is the common
   * convention), and BFS needs all of them to be able to reach the
   * implementation classes through their containing namespace. The
   * reader returns the full set; the scanner enqueues each one.
   *
   * Returns `[]` when nothing resolves (NuGet / npm package, BCL type,
   * etc.) — the calibrator + symbol provider handle those later.
   */
  resolveImports(fromRel: string, importTarget: string): Promise<string[]>;
}

export interface ScanResult {
  entryPoints: string[];
  skeleton: string[];
  /** Files we found but did not include due to {@link ScanOptions.maxFiles}. */
  overflow: string[];
  /**
   * Workspace-relative inbound adjacency: `inbound[target]` is the list of
   * skeleton files whose static imports resolve to `target`. Built as a
   * by-product of the BFS so it is free; we expose it because the
   * single-file analyzer needs to tell the LLM "this class is called from
   * those files" — that's the only way to disambiguate `public_api`
   * (no in-workspace callers) from a normal internal class without showing
   * the LLM every other file in the workspace.
   *
   * Stable ordering: discovery order during BFS. A target with zero
   * inbound edges is omitted from the map (not stored as `[]`).
   */
  inbound: Map<string, string[]>;
}

const ENTRY_PATTERNS: RegExp[] = [
  /(?:^|[\/\\])Program\.cs$/i,
  /(?:^|[\/\\])Main\.(?:cs|kt|java)$/i,
  /(?:^|[\/\\])[A-Z]\w*Endpoints\.cs$/,
  /(?:^|[\/\\])[A-Z]\w*Controller\.cs$/,
  /(?:^|[\/\\])index\.(?:ts|tsx|js|jsx)$/i,
  /(?:^|[\/\\])main\.(?:ts|tsx|js|jsx|py)$/i,
  /(?:^|[\/\\])app\.(?:ts|tsx|js|jsx|py)$/i,
  /(?:^|[\/\\])__main__\.py$/i,
  /(?:^|[\/\\])manage\.py$/i,
  /(?:^|[\/\\])server\.py$/i,
  /(?:^|[\/\\])cli\.py$/i,
];

const CSHARP_USING_RE = /(?:^|;|\n)\s*using\s+([A-Za-z_][\w.]*)\s*;/g;
const TS_IMPORT_RE = /\bimport\s+(?:[\w*{}\s,]+from\s+)?['"]([^'"]+)['"]/g;
const TS_REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
// Python: `from X import Y` and `import X` (optionally `as Z`). We capture
// the dotted module path; the file reader's `resolveImports` is responsible
// for mapping that back to a workspace-relative file (only relative-style
// `from .foo import` resolves cleanly; absolute package imports resolve to
// nothing and are treated as external by the LSP, which is correct).
const PY_FROM_IMPORT_RE = /^\s*from\s+([.\w]+)\s+import\b/gm;
const PY_IMPORT_RE = /^\s*import\s+([.\w]+)(?:\s+as\s+\w+)?/gm;

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
  } else if (ext === '.py') {
    for (const m of text.matchAll(PY_FROM_IMPORT_RE)) out.add(m[1]!);
    for (const m of text.matchAll(PY_IMPORT_RE)) out.add(m[1]!);
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
  // For centrality scoring we over-discover then rerank+slice.
  const rankBy = options.rankBy ?? 'bfs';
  const discoveryCap =
    rankBy === 'centrality'
      ? Math.min(eligible.length, Math.max(options.maxFiles * 3, 60))
      : options.maxFiles;
  const inDegree = new Map<string, number>();
  const inboundFiles = new Map<string, string[]>();
  const depthOf = new Map<string, number>();
  const queue: { file: string; depth: number }[] = seeds.map(f => ({ file: f, depth: 0 }));

  while (queue.length > 0 && skeleton.length < discoveryCap) {
    const { file, depth } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    skeleton.push(file);
    depthOf.set(file, depth);

    if (depth >= options.maxDepth) continue;

    const text = await reader.readText(file);
    if (!text) continue;
    const ext = path.extname(file).toLowerCase();
    const targets = extractImports(text, ext);

    for (const t of targets) {
      const resolvedList = await reader.resolveImports(file, t);
      for (const resolved of resolvedList) {
        if (!eligible.includes(resolved)) continue;
        // Count even if we've already enqueued — captures graph centrality
        // (a util imported by 5 callers should rank higher than one imported
        // by 1, regardless of BFS discovery order).
        inDegree.set(resolved, (inDegree.get(resolved) ?? 0) + 1);
        // Adjacency: record the caller. Dedupe preserves first-seen order.
        let inbound = inboundFiles.get(resolved);
        if (!inbound) {
          inbound = [];
          inboundFiles.set(resolved, inbound);
        }
        if (!inbound.includes(file)) inbound.push(file);
        if (seen.has(resolved)) continue;
        queue.push({ file: resolved, depth: depth + 1 });
      }
    }
  }

  // ---- Centrality rerank ----
  // Score: entry-points get a huge base bonus (they should always survive
  // the cut); after that, higher in-degree wins, deeper nodes get penalised
  // slightly so we don't drown in transitive leaves.
  let finalSkeleton = skeleton;
  if (rankBy === 'centrality' && skeleton.length > options.maxFiles) {
    const entrySet = new Set(entryPoints);
    const scored = skeleton.map(f => {
      const base = entrySet.has(f) ? 10000 : 0;
      const deg = inDegree.get(f) ?? 0;
      const d = depthOf.get(f) ?? 0;
      return { file: f, score: base + deg * 100 - d * 10 };
    });
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Stable tiebreaker: shorter paths (closer to root) first, then
      // lexicographic — keeps output deterministic across runs.
      if (a.file.length !== b.file.length) return a.file.length - b.file.length;
      return a.file.localeCompare(b.file);
    });
    finalSkeleton = scored.slice(0, options.maxFiles).map(s => s.file);
  }

  // ---- Fallback fill (opt-in) ----
  // BFS-by-import can severely under-cover languages where the scanner
  // cannot resolve imports back to files. C# `using` clauses are
  // namespaces, not paths, so a typical .NET solution produces a skeleton
  // that only contains the entry-point files (Program.cs, *Endpoints.cs).
  // To avoid silently analyzing 5 files out of 100, callers can opt in to
  // topping up the skeleton with the remaining eligible files (shortest
  // path first → closer to the project root, generally more central)
  // until `maxFiles` is reached.
  //
  // Only runs when BFS already had something to do (i.e. seeds were found).
  // An empty-seed workspace still surfaces the orchestrator's "no entry
  // points found" friendly error.
  if (options.fillToMaxFiles && seeds.length > 0 && finalSkeleton.length < options.maxFiles) {
    const taken = new Set(finalSkeleton);
    // Skip "marker" files that contain only an empty assembly-scanning
    // anchor class (e.g. .NET `AssemblyMarker.cs`, `*Marker.cs`,
    // `*ModuleAnchor.cs`). They burn one of the limited skeleton slots and
    // an LLM round-trip to produce a node with no methods / no calls / no
    // signal — the user is better served by giving that slot to a real
    // handler / repository / endpoint file instead.
    const remaining = eligible
      .filter(f => !taken.has(f) && !isMarkerFile(f))
      .sort((a, b) => {
        if (a.length !== b.length) return a.length - b.length;
        return a.localeCompare(b);
      });
    for (const f of remaining) {
      if (finalSkeleton.length >= options.maxFiles) break;
      finalSkeleton.push(f);
    }
  }

  const finalSet = new Set(finalSkeleton);
  const overflow = eligible.filter(f => !finalSet.has(f));
  // Filter the inbound map to only contain files that survived the
  // skeleton cut on BOTH sides — keys must be in the final skeleton, and
  // each caller in the value list must be too. Stale entries would
  // confuse the LLM ("this caller doesn't exist in my graph").
  const inbound = new Map<string, string[]>();
  for (const [target, callers] of inboundFiles) {
    if (!finalSet.has(target)) continue;
    const filtered = callers.filter(c => finalSet.has(c));
    if (filtered.length > 0) inbound.set(target, filtered);
  }
  return { entryPoints, skeleton: finalSkeleton, overflow, inbound };
}

/** Heuristic: files whose basename is a common assembly-scanning anchor
 *  type (e.g. .NET's `AssemblyMarker`, `ModuleAnchor`, `PluginAnchor`) hold
 *  no real code-map information — they're empty `public class X {}`
 *  declarations used by reflection to find an assembly. Skipping them in
 *  the fill phase keeps the limited skeleton slots focused on actual
 *  handlers / repositories / endpoints.
 *
 *  Pattern is intentionally conservative: only exact matches against the
 *  short list below. Anything like `EventMarker` or `UserSchemaAnchor`
 *  could be domain code, so we don't touch it. */
function isMarkerFile(relPath: string): boolean {
  const base = relPath.split(/[\/\\]/).pop() ?? relPath;
  const stem = base.replace(/\.[^.]+$/, '');
  return /^(AssemblyMarker|ModuleAnchor|PluginAnchor|AssemblyAnchor|PackageMarker)$/.test(stem);
}

