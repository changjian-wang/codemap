# Changelog

All notable changes to this extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.2 — 2026-05-20

Per-folder graph persistence, deep-focus drill-down, and golden-based eval
tooling. No breaking changes.

### Added
- **Deep `/focus` drill-down.** When the focus target is an external dep or
  an unverified ghost node, the extension now locates the defining file via
  workspace symbol provider (with a filename-based fallback for languages
  the LSP hasn't indexed yet), runs the single-file analyzer + calibrator on
  it, merges the result into the persisted graph, and re-renders ±1-hop of
  the freshly-promoted node. Falls back to the lightweight subgraph filter
  when the target is already verified.
- **`/eval` slash command** scores the current graph against
  `<folder>/.codemap/golden.json` and prints node + edge precision / recall /
  F1 with the full diff (missing nodes, missing edges, top-10 extras).
- **`CodeMap: Save Current Graph as Golden` command** snapshots the latest
  graph into `.codemap/golden.json`. Prompts for name + description,
  defaults `scopeFiles` from the current generate scope, refuses to
  overwrite without confirmation, and offers to open the file.
- **Eval trend in generate output.** When a golden exists, every
  `/scope` / generate run prints F1 deltas vs the previously-stored eval
  (`(↑+0.02)` / `(↓-0.05)` / `(·)`), so prompt / model changes surface as
  numbers, not vibes.
- **Collapsible outline groups** with caret indicators, per-section
  expand/collapse, top-level `−` / `+` toggle, search-triggered auto-expand,
  and per-workspace persistence in `localStorage`. Lets 80-class scopes stay
  navigable.
- **Vendor cytoscape / dagre / cytoscape-dagre bundled inside the VSIX**
  under `dist/vendor/`, replacing the unpkg.com CDN references. Fixes
  silent webview crashes on machines with restricted external network
  access (China firewall, corporate proxies, etc.).
- **WebView error overlay.** Uncaught script errors now surface as a red
  bar at the bottom of the panel so future regressions are diagnosable
  without opening the WebView Developer Tools.
- **`selectedNodeId` plumbed through `MockupMeta`** so `/focus` opens the
  Details card on the target class instead of whichever node happens to
  win the reading-order sort.

### Changed
- **Per-folder graph persistence.** `GraphStore` now keys by workspace
  folder path; multi-root workspaces no longer clobber each other when
  `/scope` is run against different folders. `loadLatestGraph` picks the
  freshest stored graph across roots so `/why` / `/explain` / `/focus`
  always operate on the right one.
- **`jump_to_file` resolves against the stored graph's own workspace
  folder** (passed through `showGraph`), not the first workspace folder.
  Multi-root jump-to-source no longer mis-routes between roots.
- **Skeleton fill skips assembly-marker / module-anchor files**
  (`AssemblyMarker`, `ModuleAnchor`, `PluginAnchor`, `AssemblyAnchor`,
  `PackageMarker`). These empty reflection-anchor classes were burning
  skeleton slots and LLM calls without producing useful nodes; the freed
  slots now go to real handler / endpoint / store files.
- **Aggregator no longer warns about successful same-name disambiguation.**
  The qualified ids in `graph.nodes` are the signal; the warning was
  informational noise on every run for projects with per-module
  `AssemblyMarker.cs`.
- **`mergeAnalysisIntoGraph` auto-registers new `ext:` edge targets** in
  `externalDeps`. Without this, cytoscape rejected the edges with
  "non-existent target" and aborted the whole render.
- **Outline header summary** (`N classes · M methods`) now reflects the
  rendered graph instead of the mockup's hardcoded fixture values.
- **Re-Analyze → Pick file… dialog** is filtered to known source
  extensions (`.cs`, `.ts`, `.tsx`, `.js`, `.jsx`, `.py`) with an "All
  files" escape hatch, so users can't accidentally pick a README or PNG
  as scope.

### Fixed
- Webview render crash ("`cy is not defined`") on networks where
  unpkg.com is unreachable.
- Mockup's hardcoded "14 CLASSES · 51 METHODS" outline header leaking
  through whenever the live data didn't drive that field.
- Deep-focus paths no longer downgrade an already-rich base node by
  overwriting it with a less-verified analysis result.

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
