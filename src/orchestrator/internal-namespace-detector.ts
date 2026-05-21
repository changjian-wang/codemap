/**
 * Workspace-internal namespace-root detector (v3.8).
 *
 * The v3.5–v3.7 prompt revisions lifted recall but left edge precision at
 * 0.79 on `lumen/apps/api/src`. The remaining false positives are almost
 * all of the form `ext:Lumen.Modules.Capture.AssemblyMarker` — the LLM
 * sees a `using Lumen.Modules.Capture;` import in a .cs file and tags the
 * type as external because *it* doesn't know which namespaces are
 * workspace-internal. v3.8 closes that gap by handing the LLM a small
 * list of namespace roots it should NEVER use the `ext:` prefix for.
 *
 * Detection rules (intentionally conservative — false positives here
 * propagate to "LLM may under-tag a real BCL/third-party type"):
 *
 *  - **C#**: the set of first segments of every `namespace X.Y.Z;` /
 *    `namespace X.Y.Z { … }` declaration in workspace .cs files. A
 *    namespace declared inside the workspace IS by definition
 *    project-internal; no frequency threshold is needed.
 *
 *  - **TypeScript / Node**: the `name` field of the workspace-root
 *    `package.json`. Scoped names (`@codemap/core`) contribute both
 *    `codemap` (scope without `@`) and `core` (package leaf); unscoped
 *    names contribute the bare name. This is *best-effort* — TS LLMs
 *    rarely emit `ext:codemap.core.Foo` style FQNs, so this is defence
 *    in depth, not the main fix.
 *
 *  - **Python**: deferred — top-level packages are usually obvious from
 *    `__init__.py` ancestry, but the LLM's Python output rarely emits
 *    dotted-FQN `ext:` strings either. We will add it when we see real
 *    Python recall data.
 *
 * The output is sorted, deduplicated, and free of blank entries so it
 * folds cleanly into the AnalyzerCache `hintSalt` (any change to the
 * roots invalidates every cached file in that scope).
 */

/**
 * Match `namespace X.Y.Z;` (file-scoped) or `namespace X.Y.Z {` (block).
 * Multiline so each declaration in the same file is captured.
 */
const CSHARP_NAMESPACE_RE = /^\s*namespace\s+([\w][\w.]*)\s*[;{]/gm;

/**
 * Extract the set of first-segment namespace roots from a single C#
 * source file. Returns `[]` when the file declares no namespaces (e.g.
 * top-level statements in a Program.cs).
 *
 * Exported for unit testability.
 */
export function extractCSharpNamespaceRoots(text: string): string[] {
  const roots = new Set<string>();
  for (const m of text.matchAll(CSHARP_NAMESPACE_RE)) {
    const fqn = m[1];
    if (!fqn) continue;
    const root = fqn.split('.')[0];
    if (root) roots.add(root);
  }
  return [...roots];
}

/**
 * Extract candidate internal-namespace roots from a `package.json` text.
 * Handles scoped (`@scope/pkg`) and unscoped (`pkg`) names. Silently
 * returns `[]` on malformed JSON, missing `name`, or non-string `name`.
 *
 * Exported for unit testability.
 */
export function extractTypeScriptPackageNames(packageJsonText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const name = (parsed as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) return [];
  const roots = new Set<string>();
  // Scoped name: '@scope/pkg' contributes both 'scope' and 'pkg'. Strip
  // the leading '@' so the prefix-match rule covers both `ext:scope.X` and
  // `ext:scope/X` style emissions; bare leaf catches `ext:pkg.X`.
  const scopedMatch = /^@([\w-]+)\/(.+)$/.exec(name);
  if (scopedMatch) {
    if (scopedMatch[1]) roots.add(scopedMatch[1]);
    if (scopedMatch[2]) roots.add(scopedMatch[2]);
  } else {
    roots.add(name);
  }
  return [...roots];
}

export interface InternalNamespaceInput {
  /** Workspace-relative file path → file text, for files we have texts for. */
  filesWithText: ReadonlyMap<string, string>;
  /** Raw text of the workspace-root `package.json`, when present. */
  packageJsonText?: string | undefined;
}

/**
 * Combine the per-language detectors into a sorted, deduplicated list of
 * internal-namespace roots for the workspace. Returns `[]` when no
 * declarations are found (e.g. a script-only project) — callers should
 * treat an empty list as "no scan data" and skip emitting the hint.
 */
export function detectInternalNamespaces(input: InternalNamespaceInput): string[] {
  const roots = new Set<string>();
  for (const [file, text] of input.filesWithText) {
    if (!file.toLowerCase().endsWith('.cs')) continue;
    for (const r of extractCSharpNamespaceRoots(text)) roots.add(r);
  }
  if (input.packageJsonText) {
    for (const r of extractTypeScriptPackageNames(input.packageJsonText)) roots.add(r);
  }
  return [...roots].sort();
}
