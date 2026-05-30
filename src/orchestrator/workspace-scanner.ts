// Phase 3.3a -- minimal workspace scanner.
//
// Returns the (capped, deterministic) file list the orchestrator will hand to
// analyzeFile. v4 deliberately keeps this dumb -- no BFS / centrality / entry
// detection. The downstream BC classifier + LLM analyzer already work per
// file, so picking files is just glob-by-extension + scope-prefix + depth
// sort. A smarter ranker can come back in a later slice if real-data runs
// show it's needed.

export interface FileReader {
  /** Workspace-relative paths (forward slashes). */
  listFiles(): Promise<string[]>;
  /** Read a file's text. Returns undefined when the file does not exist. */
  readText(relPath: string): Promise<string | undefined>;
}

export interface ScanOptions {
  /**
   * Workspace-relative path prefix (forward slashes). When set the scanner
   * only considers files whose path equals or starts with `<prefix>/`.
   * The cap is applied AFTER scope filtering so a narrow /scope does not
   * starve.
   */
  scopePrefix?: string;
  /** Lowercased extensions, including the leading dot. */
  extensions: string[];
  /** Hard cap on returned file count. */
  maxFiles: number;
}

export const DEFAULT_EXTENSIONS = ['.cs', '.ts', '.tsx', '.js', '.jsx', '.py'] as const;

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  extensions: [...DEFAULT_EXTENSIONS],
  maxFiles: 60,
};

export async function scanWorkspace(
  reader: FileReader,
  options: ScanOptions = DEFAULT_SCAN_OPTIONS,
): Promise<string[]> {
  if (options.maxFiles <= 0) return [];
  const all = await reader.listFiles();
  const prefix = normalizePrefix(options.scopePrefix);
  const exts = options.extensions.map((e) => e.toLowerCase());

  const eligible: string[] = [];
  for (const raw of all) {
    const f = raw.replace(/\\/g, '/');
    if (!inScope(f, prefix)) continue;
    if (!matchesExtension(f, exts)) continue;
    eligible.push(f);
  }

  eligible.sort((a, b) => {
    const da = depth(a);
    const db = depth(b);
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });

  return eligible.slice(0, options.maxFiles);
}

function normalizePrefix(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/\\/g, '/').replace(/\/+$/, '');
}

function inScope(file: string, prefix: string): boolean {
  if (!prefix) return true;
  return file === prefix || file.startsWith(prefix + '/');
}

function matchesExtension(file: string, exts: string[]): boolean {
  const lower = file.toLowerCase();
  return exts.some((e) => lower.endsWith(e));
}

function depth(file: string): number {
  let n = 0;
  for (let i = 0; i < file.length; i++) {
    if (file.charCodeAt(i) === 0x2f) n++;
  }
  return n;
}
