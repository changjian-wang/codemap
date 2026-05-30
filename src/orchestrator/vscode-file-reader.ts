// Phase 3.3b -- vscode-backed FileReader for the v4 orchestrator.
//
// The scanner core lives in workspace-scanner.ts and is vscode-free so
// vitest can unit-test it. This thin wrapper does the actual fs walk via
// vscode.workspace.findFiles (which goes through ripgrep + .gitignore).

import * as vscode from 'vscode';
import type { FileReader, ScanOptions } from './workspace-scanner';

const EXCLUDE_GLOB =
  '**/{node_modules,bin,obj,dist,out,.git,.venv,venv,__pycache__,.pytest_cache,.mypy_cache,build,_local_only}/**';

export function createVscodeFileReader(root: vscode.Uri, options: ScanOptions): FileReader {
  const includeGlob = `**/*{${options.extensions.join(',')}}`;
  const rootRel = (uri: vscode.Uri): string =>
    vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');

  return {
    async listFiles() {
      const pattern = new vscode.RelativePattern(root, includeGlob);
      const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB);
      return uris.map(rootRel);
    },
    async readText(rel) {
      try {
        const uri = vscode.Uri.joinPath(root, rel);
        const buf = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(buf).toString('utf8');
      } catch {
        return undefined;
      }
    },
  };
}
