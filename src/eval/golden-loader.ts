import * as vscode from 'vscode';
import * as path from 'path';
import type { GoldenSample } from './score';

/**
 * Loads the golden sample for the current workspace, if one exists.
 *
 * Lookup order:
 *   1. The path in setting `codemap.devGoldenPath` (workspace-relative or absolute)
 *   2. `<workspaceRoot>/.codemap/golden.json`
 *
 * Returns `undefined` quietly when no golden is found — eval just gets
 * skipped, which is what we want for normal user runs.
 */
export async function loadGoldenForWorkspace(
  workspaceRoot: vscode.Uri,
): Promise<GoldenSample | undefined> {
  const config = vscode.workspace.getConfiguration('codemap');
  const overridePath = config.get<string>('devGoldenPath', '').trim();

  const candidates: vscode.Uri[] = [];
  if (overridePath) {
    const uri = path.isAbsolute(overridePath)
      ? vscode.Uri.file(overridePath)
      : vscode.Uri.joinPath(workspaceRoot, overridePath);
    candidates.push(uri);
  }
  candidates.push(vscode.Uri.joinPath(workspaceRoot, '.codemap', 'golden.json'));

  for (const uri of candidates) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      const parsed = JSON.parse(text) as GoldenSample;
      if (!parsed.nodes || !Array.isArray(parsed.nodes)) continue;
      if (!parsed.edges || !Array.isArray(parsed.edges)) continue;
      return parsed;
    } catch {
      // Try next candidate.
    }
  }
  return undefined;
}
