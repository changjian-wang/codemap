import * as vscode from 'vscode';
import type { SymbolProvider, SymbolHit } from './symbol-provider';

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
    if (!results) return [];
    // Prefer exact-name matches first.
    const exact = results.filter(r => r.name === name);
    const others = results.filter(r => r.name !== name);
    const ordered = [...exact, ...others].slice(0, limit);
    return ordered.map(r => ({
      name: r.name,
      file: vscode.workspace.asRelativePath(r.location.uri, false),
      startLine: r.location.range.start.line + 1,
      endLine: r.location.range.end.line + 1,
      kind: vscode.SymbolKind[r.kind],
    }));
  }
}

function flatten(symbols: vscode.DocumentSymbol[], file: string): SymbolHit[] {
  const out: SymbolHit[] = [];
  const walk = (s: vscode.DocumentSymbol): void => {
    out.push({
      name: s.name,
      file,
      startLine: s.range.start.line + 1,
      endLine: s.range.end.line + 1,
      kind: vscode.SymbolKind[s.kind],
    });
    s.children?.forEach(walk);
  };
  symbols.forEach(walk);
  return out;
}
