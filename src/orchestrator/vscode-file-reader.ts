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
  const excludeGlob = '**/{node_modules,bin,obj,dist,out,.git}/**';

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
      // C# using statements are namespaces, not file paths — we leave them
      // to the calibrator's symbol provider. For TS/JS we resolve relative
      // imports and probe the usual extensions.
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
