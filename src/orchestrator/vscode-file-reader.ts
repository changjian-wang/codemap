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

  return {
    async listFiles() {
      const uris = await vscode.workspace.findFiles(includeGlob, excludeGlob);
      return uris.map(u => vscode.workspace.asRelativePath(u, false));
    },
    readText,
    async resolveImport(fromRel, importTarget) {
      const ext = path.extname(fromRel).toLowerCase();

      // ---- Python: only relative imports (".foo", "..bar.baz") resolve to
      // a workspace file. Absolute package imports go through the LSP. ----
      if (ext === '.py') {
        if (!importTarget.startsWith('.')) return undefined;
        // Count leading dots — `.` means current pkg, `..` means parent, etc.
        const leadingDots = importTarget.match(/^\.+/)?.[0].length ?? 0;
        const rest = importTarget.slice(leadingDots).replace(/\./g, '/');
        // From a file in `pkg/sub/mod.py`, `.foo` resolves against `pkg/sub/`;
        // `..foo` resolves against `pkg/`.
        let baseDir = path.dirname(fromRel);
        for (let i = 1; i < leadingDots; i++) baseDir = path.dirname(baseDir);
        const joined = rest ? path.normalize(path.join(baseDir, rest)) : baseDir;
        const candidates = [joined + '.py', path.join(joined, '__init__.py')];
        for (const c of candidates) {
          const text = await readText(c);
          if (text !== undefined) return c.replace(/\\/g, '/');
        }
        return undefined;
      }

      // ---- C# `using` statements are namespaces, not file paths — we
      // leave them to the calibrator's symbol provider. ----
      // ---- TS/JS: resolve relative imports + probe usual extensions. ----
      if (!importTarget.startsWith('.')) return undefined;
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
        if (text !== undefined) return c.replace(/\\/g, '/');
      }
      return undefined;
    },
  };
}
