import * as vscode from 'vscode';
import type { SymbolProvider, SymbolHit, SymbolTreeNode } from './symbol-provider';
import { flattenSymbolTree } from './symbol-provider';

/**
 * VS Code-backed {@link SymbolProvider}.
 *
 * Lives in its own module so calibrator core stays test-friendly (vitest
 * cannot resolve the `vscode` module without the extension host).
 */
export class VscodeSymbolProvider implements SymbolProvider {
  constructor(private workspaceRoot: vscode.Uri) {}

  async symbolsInFile(file: string): Promise<SymbolHit[] | undefined> {
    const uri = vscode.Uri.joinPath(this.workspaceRoot, file);
    // The symbol provider can return `undefined` while the language server
    // is still indexing (especially C# Dev Kit on a fresh open) or an empty
    // array if the file is empty. We retry with a short backoff once before
    // giving up; the orchestrator's warmup phase also tries to make sure the
    // first call already hits a ready server.
    for (const delayMs of [0, 500]) {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
        'vscode.executeDocumentSymbolProvider',
        uri,
      );
      if (symbols === undefined) continue;          // not ready
      if (symbols.length === 0) {
        // File really has no symbols. Distinct from "not ready" — return
        // an explicit empty array.
        return [];
      }
      return flatten(symbols, file);
    }
    // Two attempts and still nothing — report "no signal" rather than
    // "no symbols". Calibrator preserves verified state in this case.
    return undefined;
  }

  async findInWorkspace(name: string, limit = 10): Promise<SymbolHit[]> {
    const results = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      name,
    );
    const lspHits: SymbolHit[] = [];
    if (results && results.length > 0) {
      // Prefer exact-name matches first.
      const exact = results.filter(r => r.name === name);
      const others = results.filter(r => r.name !== name);
      const ordered = [...exact, ...others].slice(0, limit);
      for (const r of ordered) {
        lspHits.push({
          name: r.name,
          file: vscode.workspace.asRelativePath(r.location.uri, false),
          startLine: r.location.range.start.line + 1,
          endLine: r.location.range.end.line + 1,
          kind: vscode.SymbolKind[r.kind],
        });
      }
      // Keep LSP results scoped to *this* root (multi-root workspaces leak
      // results from sibling folders); a relative path that starts with
      // `..` or is absolute means asRelativePath couldn't put it under the
      // root.
      const inRoot = lspHits.filter(h => !h.file.startsWith('..') && !/^[a-zA-Z]:\\/.test(h.file));
      if (inRoot.length > 0) return inRoot;
    }

    // ---- Fallback: filename heuristic ----
    // The workspace symbol provider returns nothing when the language server
    // hasn't indexed this folder (common in multi-root workspaces where
    // C# Dev Kit only loads the first .sln, or before TS LSP finishes its
    // first crawl). For these cases, search for `<Name>.{cs,ts,tsx,...}`
    // under this root and verify the file actually declares the symbol by
    // grepping for `class|interface|record|struct|enum <Name>`.
    //
    // Scoped via RelativePattern so a workspace folder's neighbours aren't
    // accidentally probed.
    const exts = ['cs', 'ts', 'tsx', 'js', 'jsx', 'py', 'kt', 'java'];
    const pattern = new vscode.RelativePattern(this.workspaceRoot, `**/${name}.{${exts.join(',')}}`);
    const fileUris = await vscode.workspace.findFiles(
      pattern,
      '**/{node_modules,bin,obj,dist,out,.git,.venv,venv,__pycache__,build}/**',
      Math.max(limit, 10),
    );
    const declRe = new RegExp(`\\b(class|interface|record|struct|enum)\\s+${escapeRegex(name)}\\b`);
    const fallbackHits: SymbolHit[] = [];
    for (const uri of fileUris) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        if (!declRe.test(text)) continue;
        // Approximate the declaration line; refining is the calibrator's job.
        const lines = text.split(/\r?\n/);
        const matchIdx = lines.findIndex((l: string) => declRe.test(l));
        const startLine = matchIdx >= 0 ? matchIdx + 1 : 1;
        fallbackHits.push({
          name,
          file: vscode.workspace.asRelativePath(uri, false),
          startLine,
          endLine: startLine,
          kind: 'Class',
        });
        if (fallbackHits.length >= limit) break;
      } catch {
        // Skip unreadable files.
      }
    }
    return fallbackHits;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function flatten(symbols: vscode.DocumentSymbol[], file: string): SymbolHit[] {
  const toNode = (s: vscode.DocumentSymbol): SymbolTreeNode => ({
    name: s.name,
    kind: vscode.SymbolKind[s.kind],
    startLine: s.range.start.line + 1,
    endLine: s.range.end.line + 1,
    children: s.children?.map(toNode),
  });
  return flattenSymbolTree(symbols.map(toNode), file);
}
