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

  async symbolsInFile(file: string): Promise<SymbolHit[]> {
    const uri = vscode.Uri.joinPath(this.workspaceRoot, file);
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );
    if (!symbols) return [];
    return flatten(symbols, file);
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
