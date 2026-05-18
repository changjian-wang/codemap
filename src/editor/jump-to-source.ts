import * as vscode from 'vscode';

/**
 * Jump to a class (or class+method) in the workspace.
 *
 * v2 §7.6 fallback chain:
 *   1. Open the file at the LLM-supplied range, verify the symbol name
 *      actually appears in that range. If it does, we're done.
 *   2. If not, query the document's symbols and re-locate the class.
 *   3. If that fails, search the workspace by name.
 *   4. If all of the above fail, show a friendly warning and abort
 *      (we never silently jump to the wrong line).
 *
 * Unverified nodes are never jumped to — see v3 plan §5.4 ("no jump for
 * grey ghost nodes"). The panel disables the button visually but we
 * defend against a stray message as well.
 */

export interface JumpRequest {
  /** Workspace-relative path. */
  file: string;
  /** Class name to highlight. */
  nodeId: string;
  /** Optional method name; if set we jump to the method inside the class. */
  method?: string;
  /** LLM/calibrator-supplied 1-based line of the class. */
  classLine?: number;
  /** LLM-supplied 1-based line of the method. */
  methodLine?: number;
  /** verification state of the source node; we refuse to jump to 'unverified'. */
  verification: 'verified' | 'partial' | 'unverified';
}

export async function jumpToSource(
  workspaceRoot: vscode.Uri,
  req: JumpRequest,
): Promise<boolean> {
  if (req.verification === 'unverified') {
    vscode.window.showWarningMessage(
      `${req.nodeId} is unverified — refusing to jump (the location is not trusted).`,
    );
    return false;
  }

  const uri = vscode.Uri.joinPath(workspaceRoot, req.file);

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (err) {
    vscode.window.showWarningMessage(
      `Could not open ${req.file}: ${(err as Error).message}`,
    );
    return false;
  }

  const targetName = req.method ?? req.nodeId.split('.').pop() ?? req.nodeId;

  // Level 1: try the LLM-supplied line.
  const candidateLine = req.method ? req.methodLine : req.classLine;
  if (candidateLine && candidateLine > 0) {
    const text = doc.lineAt(Math.min(candidateLine - 1, doc.lineCount - 1)).text;
    if (text.includes(targetName)) {
      await revealAt(uri, candidateLine - 1, doc);
      return true;
    }
  }

  // Level 2: re-query document symbols, find the class (and method).
  const docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
    'vscode.executeDocumentSymbolProvider',
    uri,
  );
  if (docSymbols && docSymbols.length > 0) {
    const hit = findSymbol(docSymbols, req.nodeId, req.method);
    if (hit) {
      await revealAt(uri, hit.selectionRange.start.line, doc);
      return true;
    }
  }

  // Level 3: workspace symbol search.
  const wsHits = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
    'vscode.executeWorkspaceSymbolProvider',
    targetName,
  );
  if (wsHits && wsHits.length > 0) {
    const exact =
      wsHits.find(h => h.name === targetName && h.location.uri.fsPath === uri.fsPath) ??
      wsHits.find(h => h.name === targetName) ??
      wsHits[0];
    if (exact) {
      await vscode.window.showTextDocument(exact.location.uri, {
        selection: exact.location.range,
      });
      return true;
    }
  }

  // Level 4: graceful failure.
  vscode.window.showWarningMessage(
    `Could not locate ${req.method ? req.nodeId + '.' + req.method : req.nodeId} in ${req.file}. ` +
      'The graph may be stale — try Re-Analyze.',
  );
  return false;
}

async function revealAt(uri: vscode.Uri, lineZeroBased: number, doc: vscode.TextDocument): Promise<void> {
  const range = doc.lineAt(lineZeroBased).range;
  await vscode.window.showTextDocument(uri, { selection: range });
}

function findSymbol(
  syms: vscode.DocumentSymbol[],
  className: string,
  methodName: string | undefined,
): vscode.DocumentSymbol | undefined {
  const targetClass = className.split('.').pop() ?? className;
  for (const s of syms) {
    if (s.name === targetClass || s.name === stripGenerics(targetClass)) {
      if (!methodName) return s;
      const m = (s.children ?? []).find(c => c.name === methodName || c.name.startsWith(methodName + '('));
      if (m) return m;
      return s; // class found, method not — fall back to class location
    }
    const recursed = findSymbol(s.children ?? [], className, methodName);
    if (recursed) return recursed;
  }
  return undefined;
}

function stripGenerics(name: string): string {
  return name.replace(/<.*>$/, '');
}
