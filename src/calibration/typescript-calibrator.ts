// Phase 2.6 -- in-process TypeScript / JavaScript calibrator backed by
// ts-morph. Mirrors the semantics of CSharpCalibratorHost but runs
// inside the extension host, so there is no subprocess to spawn / kill.
//
// Scope of 2.6 (acceptance: resolve callees of `activate` in
// src/extension.ts, must include `registerChatParticipant`):
//   - Load a project via tsconfig.json (slnxPath is reinterpreted as a
//     tsconfig path, or a directory containing one).
//   - Resolve callees for top-level FunctionDeclaration and class-body
//     MethodDeclaration. Iterates CallExpression and NewExpression
//     descendants of the method body (lambdas / arrow functions are
//     descended into).
//
// Phase 2.7 (AFK) will extend this to arrow-function properties and
// free-standing const-assigned functions, plus the parity test set
// against the C# implementation.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  Project,
  SyntaxKind,
  Node,
  type CallExpression,
  type ClassDeclaration,
  type FunctionDeclaration,
  type MethodDeclaration,
  type NewExpression,
  type SourceFile,
  type Symbol as TsSymbol,
} from 'ts-morph';

import type { CalibratorService } from './calibrator-service';
import type {
  Callee,
  CalleeKind,
  LoadSolutionParams,
  LoadSolutionResult,
  LoadedProject,
  ResolveCalleesParams,
  ResolveCalleesResult,
} from '../shared/calibrator-protocol';

export class TypeScriptCalibratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypeScriptCalibratorError';
  }
}

export class TypeScriptCalibrator implements CalibratorService {
  private project: Project | null = null;
  private tsConfigPath: string | null = null;

  async loadSolution(params: LoadSolutionParams): Promise<LoadSolutionResult> {
    const start = Date.now();
    const tsConfigPath = resolveTsConfigPath(params.slnxPath);

    const project = new Project({
      tsConfigFilePath: tsConfigPath,
      skipAddingFilesFromTsConfig: false,
    });

    this.project = project;
    this.tsConfigPath = tsConfigPath;

    const sourceFiles = project.getSourceFiles();
    const project0: LoadedProject = {
      name: deriveProjectName(tsConfigPath),
      filePath: tsConfigPath,
      language: 'TypeScript',
      assemblyName: deriveProjectName(tsConfigPath),
    };

    const elapsedMs = Date.now() - start;
    return {
      slnxPath: tsConfigPath,
      declaredProjectCount: 1,
      loadedProjectCount: 1,
      distinctProjectCount: 1,
      projects: [project0],
      skipped: [],
      diagnostics: [`Loaded ${sourceFiles.length} source files via ts-morph`],
      elapsedMs,
    };
  }

  async resolveCallees(params: ResolveCalleesParams): Promise<ResolveCalleesResult> {
    if (!this.project) {
      throw new TypeScriptCalibratorError(
        'loadSolution must be called before resolveCallees',
      );
    }
    const start = Date.now();

    const sourceFile = findSourceFile(this.project, params.filePath);
    if (!sourceFile) {
      throw new TypeScriptCalibratorError(`source file not found: ${params.filePath}`);
    }

    const decl = findMethodDeclaration(sourceFile, params.classId, params.methodName, params.line);
    if (!decl) {
      throw new TypeScriptCalibratorError(
        `method not found: ${params.classId || '<top-level>'}.${params.methodName} (line ${params.line})`,
      );
    }

    const callees: Callee[] = [];
    const calls = decl.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      const callee = projectCall(call);
      if (callee) callees.push(callee);
    }
    const news = decl.getDescendantsOfKind(SyntaxKind.NewExpression);
    for (const ne of news) {
      const callee = projectNew(ne);
      if (callee) callees.push(callee);
    }

    const fqn = symbolToFqn(decl.getSymbol(), `${params.classId || ''}.${params.methodName}`);

    return {
      filePath: sourceFile.getFilePath(),
      classId: params.classId,
      methodName: params.methodName,
      methodFullyQualifiedName: fqn,
      callees,
      elapsedMs: Date.now() - start,
    };
  }

  async dispose(): Promise<void> {
    this.project = null;
    this.tsConfigPath = null;
  }
}

// =========================================================================
//   helpers
// =========================================================================

function resolveTsConfigPath(raw: string): string {
  if (!raw) {
    throw new TypeScriptCalibratorError('slnxPath is required');
  }
  if (!existsSync(raw)) {
    throw new TypeScriptCalibratorError(`path does not exist: ${raw}`);
  }
  const stat = statSync(raw);
  if (stat.isFile()) {
    return raw;
  }
  const candidate = join(raw, 'tsconfig.json');
  if (!existsSync(candidate)) {
    throw new TypeScriptCalibratorError(
      `no tsconfig.json found at ${raw} or ${candidate}`,
    );
  }
  return candidate;
}

function deriveProjectName(tsConfigPath: string): string {
  const parts = tsConfigPath.split(/[\\/]/);
  // Use the parent folder name as a stand-in project name.
  return parts.length >= 2 ? parts[parts.length - 2] : 'tsproject';
}

function findSourceFile(project: Project, filePath: string): SourceFile | undefined {
  const exact = project.getSourceFile(filePath);
  if (exact) return exact;
  const lower = filePath.toLowerCase();
  return project
    .getSourceFiles()
    .find((sf) => sf.getFilePath().toLowerCase() === lower);
}

function findMethodDeclaration(
  sourceFile: SourceFile,
  classId: string,
  methodName: string,
  line: number,
): FunctionDeclaration | MethodDeclaration | undefined {
  const candidates: Array<FunctionDeclaration | MethodDeclaration> = [];

  if (!classId) {
    for (const fn of sourceFile.getFunctions()) {
      if (fn.getName() === methodName) candidates.push(fn);
    }
  }

  for (const cls of sourceFile.getClasses()) {
    if (classId && !matchesClass(cls, classId)) continue;
    for (const m of cls.getMethods()) {
      if (m.getName() === methodName) candidates.push(m);
    }
  }

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  // Overload disambiguation by line span (mirrors the C# resolver).
  const covering = candidates.find((c) => {
    const startLine = c.getStartLineNumber();
    const endLine = c.getEndLineNumber();
    return line >= startLine && line <= endLine;
  });
  if (covering) return covering;

  let closest = candidates[0];
  let closestDelta = Math.abs(closest.getStartLineNumber() - line);
  for (const c of candidates.slice(1)) {
    const delta = Math.abs(c.getStartLineNumber() - line);
    if (delta < closestDelta) {
      closest = c;
      closestDelta = delta;
    }
  }
  return closest;
}

function matchesClass(cls: ClassDeclaration, classId: string): boolean {
  const name = cls.getName();
  if (!name) return false;
  if (name === classId) return true;
  // Allow FQN-style class ids (e.g. "Namespace.Class"); ts-morph file is
  // also a namespace boundary, but for the v2 graph shape (bare class
  // names) the simple-name match above is the dominant path.
  return false;
}

function projectCall(call: CallExpression): Callee | null {
  const expr = call.getExpression();
  const displayName = expr.getText();
  const invocationLine = call.getStartLineNumber();
  const symbol = expr.getSymbolOrThrow ? safeGetSymbol(expr) : undefined;

  if (!symbol) {
    return makeUnknown(displayName, invocationLine);
  }
  return symbolToCallee(symbol, displayName, invocationLine, classifyCall(call, symbol));
}

function projectNew(ne: NewExpression): Callee | null {
  const expr = ne.getExpression();
  const displayName = `new ${expr.getText()}`;
  const invocationLine = ne.getStartLineNumber();
  const symbol = safeGetSymbol(expr);
  if (!symbol) {
    return makeUnknown(displayName, invocationLine);
  }
  return symbolToCallee(symbol, displayName, invocationLine, 'constructor');
}

function safeGetSymbol(node: Node): TsSymbol | undefined {
  try {
    const s = node.getSymbol();
    if (!s) return undefined;
    return followAliases(s);
  } catch {
    return undefined;
  }
}

function followAliases(symbol: TsSymbol): TsSymbol {
  let cur = symbol;
  // Imports return alias symbols whose declaration is the ImportSpecifier.
  // Walk to the underlying declaration symbol so callers see the real
  // source file / kind / containing type. Capped to prevent any
  // accidental cycle.
  for (let i = 0; i < 8; i++) {
    const next = cur.getAliasedSymbol();
    if (!next || next === cur) return cur;
    cur = next;
  }
  return cur;
}

function classifyCall(call: CallExpression, symbol: TsSymbol): CalleeKind {
  const decls = symbol.getDeclarations();
  if (decls.length === 0) return 'unknown';
  const first = decls[0];
  if (Node.isMethodDeclaration(first) || Node.isMethodSignature(first)) return 'method';
  if (Node.isFunctionDeclaration(first)) {
    const ancestorFn = first.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a));
    return ancestorFn ? 'localFunction' : 'method';
  }
  if (Node.isConstructorDeclaration(first)) return 'constructor';
  // Property assignments (arrow functions) -- treated as 'method' for 2.6
  // parity; 2.7 will refine.
  void call;
  return 'method';
}

function symbolToCallee(
  symbol: TsSymbol,
  displayName: string,
  invocationLine: number,
  kind: CalleeKind,
): Callee {
  const decls = symbol.getDeclarations();
  const externalDecls = decls.filter((d) => isExternalDecl(d));
  const internalDecls = decls.filter((d) => !isExternalDecl(d));
  const isExternal = decls.length > 0 && internalDecls.length === 0;

  let filePath: string | null = null;
  let line: number | null = null;
  if (!isExternal && internalDecls.length > 0) {
    const d = internalDecls[0];
    filePath = d.getSourceFile().getFilePath();
    line = d.getStartLineNumber();
  }

  void externalDecls;

  const containingType = deriveContainingType(symbol);
  const methodName = symbol.getName();

  return {
    displayName,
    fullyQualifiedName: symbolToFqn(symbol, `${containingType ? containingType + '.' : ''}${methodName}`),
    containingType,
    methodName,
    kind,
    isExternal,
    isExtension: false,
    filePath,
    line,
    invocationLine,
  };
}

function makeUnknown(displayName: string, invocationLine: number): Callee {
  return {
    displayName,
    fullyQualifiedName: displayName,
    containingType: '',
    methodName: displayName.split('.').pop() ?? displayName,
    kind: 'unknown',
    isExternal: false,
    isExtension: false,
    filePath: null,
    line: null,
    invocationLine,
  };
}

function deriveContainingType(symbol: TsSymbol): string {
  const decls = symbol.getDeclarations();
  for (const d of decls) {
    if (Node.isMethodDeclaration(d) || Node.isMethodSignature(d)) {
      const parent = d.getFirstAncestor(
        (a) => Node.isClassDeclaration(a) || Node.isInterfaceDeclaration(a),
      );
      if (parent && (Node.isClassDeclaration(parent) || Node.isInterfaceDeclaration(parent))) {
        return parent.getName() ?? '';
      }
    }
  }
  return '';
}

function symbolToFqn(symbol: TsSymbol | undefined, fallback: string): string {
  if (!symbol) return fallback;
  const raw = symbol.getFullyQualifiedName();
  // Strip module-path prefix like `"/abs/path/file".Foo.bar` -> `Foo.bar`.
  const stripped = raw.replace(/^"[^"]*"\./, '');
  return stripped || fallback;
}

function isExternalDecl(decl: Node): boolean {
  const sf = decl.getSourceFile();
  if (sf.isInNodeModules()) return true;
  if (sf.isDeclarationFile()) return true;
  return false;
}
