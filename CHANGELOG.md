# Changelog

All notable changes to this extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.1 — 2026-05-19

First public release.

### Added
- `@codemap` chat participant in GitHub Copilot Chat.
- Workspace scanner + single-file analyzer that produce a class-level UML graph.
- LSP calibration pass against `executeDocumentSymbolProvider` /
  `executeWorkspaceSymbolProvider`; nodes badged `✓ verified`, `⚠ partial`, or
  `✗ unverified`. `/why <Class>` explains the badge.
- Reading Order panel using DFS from entry classes, with risk-first /
  confidence-aware traversal.
- Interactive Cytoscape graph with dagre layout, UML class compartments, and a
  colored minimap.
- Details panel with expandable methods, **clickable file path + dedicated
  Jump-to-file button** (4-level fallback chain: LLM line → docSymbols →
  workspace symbols → friendly fail), risk pills, and `/why` explanations.
- Slash commands: `/scope`, `/focus`, `/why`, `/explain`.
- **Pick scope from the panel.** Clicking the breadcrumb repo pill opens a
  QuickPick (whole workspace / pick folder / pick file / type path).
- **Multi-root workspace scope resolution.** `/scope` accepts
  `<folderName>/<sub>`, absolute paths, or bare relative paths in single-root
  workspaces. Ambiguous bare paths in multi-root workspaces are refused with
  an actionable disambiguation hint.
- **Export the current graph** as a self-contained HTML snapshot (full
  interactive view, opens in any browser, no VS Code required) or as a
  lossless YAML dump for scripts / LLM re-consumption. `↓ Export` button in
  the panel header.
- Reading progress (mark read / mark unread) persisted in `workspaceState`.
- Per-file analyzer cache keyed on (prompt version, file path, file
  contents); a second `generate codemap` on the same workspace is ~free.
- `docComment` extraction for both classes and methods (verbatim source-doc
  text surfaced in the card).
- Node kinds: `class | interface | record | enum` end-to-end.
- Eval harness with node + edge precision/recall scoring against optional
  `<workspace>/.codemap/golden.json`.

### Scanner notes
- Default skeleton cap: 80 files (`codemap.maxSkeletonFiles`).
- Top-up pass for languages whose imports don't resolve back to files
  (C# `using` is a namespace; Python absolute imports go through the LSP).
  Without it a .NET solution would BFS-stop at the 5 entry points and the
  remaining files would be silently dropped.

### Fixed
- C# generic classes (e.g. `ValidationFilter<T>`) were marked `unverified`
  and jump-to-file silently no-op'd, because the calibrator only stripped
  `<...>` from the LLM side of the comparison while the C# LSP returns
  `DocumentSymbol.name` with type parameters baked in. The match is now
  symmetric.
- Card file-line now renders as a dim, non-clickable `<span>` (with
  cursor: not-allowed) when the node is `unverified`, instead of a styled
  anchor that posted a request the host would silently refuse.
- Jump-to-source warning now points the user at Re-Analyze instead of
  just saying "refusing to jump".

### Tests
- 201/201 unit tests passing across orchestrator, scanner, calibrator,
  aggregator, chat responders, eval scoring, and export formatters.
