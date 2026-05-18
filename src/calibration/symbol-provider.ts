/**
 * SymbolIndex — calibrator's source of truth for "does this symbol actually
 * exist?". Wraps VS Code's DocumentSymbolProvider / WorkspaceSymbolProvider
 * behind a narrow interface so tests can fake the LSP entirely.
 *
 * Two scopes:
 *   - per-file (file URI): used to validate in-file `calls` targets
 *   - workspace-wide: used to soft-validate `external_calls` and to resolve
 *     cross-file calls during aggregation (W3)
 */

export interface SymbolHit {
  /** The class / method name as the LSP returned it. */
  name: string;
  /** Workspace-relative file path containing the symbol. */
  file: string;
  /** 1-based start line. */
  startLine: number;
  /** 1-based end line (inclusive). */
  endLine: number;
  /**
   * Kind hint from the language server. We do not use it for filtering yet
   * (the LLM's `kind` field is informational), but it lets us debug surprising
   * matches.
   */
  kind?: string;
}

export interface SymbolProvider {
  /**
   * Return all class-like symbols in the given file. Used to validate
   * `node_id` and to overwrite LLM-supplied `range`.
   *
   * Returns:
   *   - `SymbolHit[]` with content → the LSP responded with symbols
   *   - `[]` empty array → the LSP responded but the file genuinely has no
   *     top-level symbols (e.g. an empty file)
   *   - `undefined` → the LSP did not respond (extension still loading,
   *     server crashed, file not indexed yet). Calibrator MUST NOT
   *     downgrade a node to unverified in this case — see v3 plan §5.4
   *     ("missing signal" ≠ "missing symbol").
   */
  symbolsInFile(file: string): Promise<SymbolHit[] | undefined>;

  /**
   * Search the entire workspace for a symbol name. Used to soft-validate
   * `external_calls` and (in W3) to resolve cross-file `calls`.
   * Returns up to {@link limit} candidates, prefer-exact-match first.
   */
  findInWorkspace(name: string, limit?: number): Promise<SymbolHit[]>;
}
