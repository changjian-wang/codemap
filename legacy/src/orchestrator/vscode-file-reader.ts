import * as vscode from 'vscode';
import * as path from 'path';
import type { FileReader, ScanOptions } from './workspace-scanner';

/**
 * vscode-backed {@link FileReader}. Lives in its own module so the scanner
 * core can be unit-tested without a vscode runtime (vitest cannot resolve
 * 'vscode').
 */
export function createVscodeFileReader(root: vscode.Uri, options: ScanOptions): FileReader {
  // vscode.workspace.findFiles already uses ripgrep under the hood and
  // respects .gitignore, so we don't need to spawn rg ourselves.
  const includeGlob = `**/*{${options.extensions.join(',')}}`;
  // Skip noise directories across all languages. `_local_only/` is the
  // agent-framework convention for never-committed scratch files; the
  // Python cluster (`.venv`, `__pycache__`, `*.egg-info`, `.pytest_cache`,
  // `.mypy_cache`, `build/`) covers virtualenv + build artefacts; the
  // TS / .NET / generic cluster covers `node_modules`, `bin`, `obj`,
  // `dist`, `out`, `.git`.
  const excludeGlob =
    '**/{node_modules,bin,obj,dist,out,.git,.venv,venv,__pycache__,.pytest_cache,.mypy_cache,build,_local_only}/**';

  const readText = async (rel: string): Promise<string | undefined> => {
    try {
      const uri = vscode.Uri.joinPath(root, rel);
      const buf = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(buf).toString('utf8');
    } catch {
      return undefined;
    }
  };

  // Lazy namespace → files index for C#. Built on first C# resolve and
  // reused for every subsequent one. We scan every workspace .cs file
  // once, extract the namespace declaration(s), and remember which
  // namespace each file belongs to. `using Foo.Bar` then resolves to
  // every file declaring `namespace Foo.Bar` (file-scoped or block).
  // Without this index BFS could not cross a csproj boundary, because
  // C# imports are namespace references rather than relative paths and
  // there is no way to derive the file from the import string alone.
  let csNamespaceIndex: Map<string, string[]> | undefined;
  const NAMESPACE_RE = /^\s*namespace\s+([\w.]+)\s*[;{]/m;
  const buildCsNamespaceIndex = async (): Promise<Map<string, string[]>> => {
    if (csNamespaceIndex) return csNamespaceIndex;
    const idx = new Map<string, string[]>();
    const uris = await vscode.workspace.findFiles('**/*.cs', excludeGlob);
    const rels = uris.map(u => vscode.workspace.asRelativePath(u, false));
    // Read in small batches; ~hundreds of files is fine on a modern SSD
    // but unbounded Promise.all on thousands of files can spike memory.
    const BATCH = 32;
    for (let i = 0; i < rels.length; i += BATCH) {
      const slice = rels.slice(i, i + BATCH);
      await Promise.all(slice.map(async rel => {
        const text = await readText(rel);
        if (!text) return;
        const m = text.match(NAMESPACE_RE);
        if (!m) return;
        const ns = m[1]!;
        let arr = idx.get(ns);
        if (!arr) { arr = []; idx.set(ns, arr); }
        arr.push(rel);
      }));
    }
    csNamespaceIndex = idx;
    return idx;
  };

  return {
    async listFiles() {
      const uris = await vscode.workspace.findFiles(includeGlob, excludeGlob);
      return uris.map(u => vscode.workspace.asRelativePath(u, false));
    },
    readText,
    async resolveImports(fromRel, importTarget) {
      const ext = path.extname(fromRel).toLowerCase();

      // ---- C#: `using X.Y.Z;` → every file declaring `namespace X.Y.Z`.
      // BFS uses this to walk across csproj boundaries. A single import
      // can resolve to many files (one type per file is the .NET norm),
      // so we return them all and let the scanner enqueue each one.
      if (ext === '.cs') {
        const idx = await buildCsNamespaceIndex();
        const files = idx.get(importTarget);
        if (!files || files.length === 0) return [];
        // Exclude self-references — a file using its own namespace would
        // otherwise log itself as inbound.
        return files.filter(f => f !== fromRel);
      }

      // ---- Python: only relative imports (".foo", "..bar.baz") resolve to
      // a workspace file. Absolute package imports go through the LSP. ----
      if (ext === '.py') {
        if (!importTarget.startsWith('.')) return [];
        const leadingDots = importTarget.match(/^\.+/)?.[0].length ?? 0;
        const rest = importTarget.slice(leadingDots).replace(/\./g, '/');
        let baseDir = path.dirname(fromRel);
        for (let i = 1; i < leadingDots; i++) baseDir = path.dirname(baseDir);
        const joined = rest ? path.normalize(path.join(baseDir, rest)) : baseDir;
        const candidates = [joined + '.py', path.join(joined, '__init__.py')];
        for (const c of candidates) {
          const text = await readText(c);
          if (text !== undefined) return [c.replace(/\\/g, '/')];
        }
        return [];
      }

      // ---- TS/JS: resolve relative imports + probe usual extensions. ----
      if (!importTarget.startsWith('.')) return [];
      const baseDir = path.dirname(fromRel);
      const joined = path.normalize(path.join(baseDir, importTarget));
      const candidates = [
        joined,
        joined + '.ts',
        joined + '.tsx',
        joined + '.js',
        joined + '.jsx',
        path.join(joined, 'index.ts'),
        path.join(joined, 'index.tsx'),
        path.join(joined, 'index.js'),
      ];
      for (const c of candidates) {
        const text = await readText(c);
        if (text !== undefined) return [c.replace(/\\/g, '/')];
      }
      return [];
    },
  };
}
