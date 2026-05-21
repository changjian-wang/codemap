# Changelog

All notable changes to this extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.4 — 2026-05-20

Hotfix on v0.0.3 plus a packaging / Marketplace pass. The v3 calibrator
change shipped a regression that flagged every C# type as `unverified`
because the new "top-level" detection used recursion depth
(`depth === 0`) — but C# Dev Kit wraps a file's contents in a
`namespace` DocumentSymbol, putting every actual class at depth 1. The
eval round on `lumen/apps/api/src` returned 119/119 unverified and Edges
F1=0.88. Same release ships the extension icon, fills in the Marketplace
storefront metadata, trims the dev-only mockup HTML out of the VSIX, and
corrects a bounded-context classification regression in the `/focus`
cache-miss path. Pure recommended upgrade from 0.0.3.

### Fixed
- **"Top-level type" is now defined by ancestry, not depth.** A symbol is
  top-level iff no ancestor in the DocumentSymbol tree is a type
  container (`Class`, `Struct`, `Interface`, `Enum`); namespaces and
  modules are explicitly NOT type containers, so types declared inside a
  C# `namespace` block, a TypeScript `namespace`, etc. correctly come
  through as top-level. `CALIBRATOR_VERSION` bumped v3 → v4 so the
  AnalyzerCache invalidates entries produced under the buggy v3 logic.
- **`flatten()` is now a thin adapter around a pure helper**
  (`flattenSymbolTree`) that has no `vscode` import. This makes the
  top-level detection unit-testable without the extension host; the
  fix ships with 7 regression tests covering the C# namespace pattern,
  nested types inside `Class` / `Struct` / `Interface`, nested
  namespaces, file-root types (TS / Python / JS), and the kind / line
  passthrough.
- **`/focus` cache-miss path mis-classified the bounded context of newly
  discovered classes.** `deep-focus.ts` was reading
  `classify(file).boundedContext`, which doesn't exist on
  `BcClassification` (the real field is `.bucket`). Cache-miss nodes
  ended up with `undefined` as their bc and lost color in the UML view.

### Added
- **Extension icon** (`media/icon.png`, 128×128). Three UML class boxes
  in the mockup palette (capture / recall / host) connected by call
  edges — the same metaphor the WebView renders.
- **Marketplace storefront metadata**: `keywords`, `bugs`, `homepage`,
  `galleryBanner` (dark theme, color matched to the WebView background).

### Changed
- **Marketplace categories**: `["Visualization", "Other"]` →
  `["AI", "Chat", "Visualization"]` so the extension shows up under the
  AI / Chat storefront sections, not just the catch-all Other bucket.
- **`.vscodeignore` excludes `docs/mockups/**` and `media/*.svg`.** The
  118 KB `lumen-backend-v3.html` design reference and the editable SVG
  icon source were getting bundled into the VSIX; only the runtime PNG
  ships now. Final VSIX: 12 files / 325 KB (was 352 KB before the
  exclusion).
- **README status line** updated from `v0.0.1` to reflect the current
  release.
- **CONTRIBUTING.md**: corrected the stale test-count snippet
  (`181 tests, ~4s` → `247 tests, ~1.5s`) and replaced an inherited
  template note about a non-existent ESLint plugin with the actual
  `npm run lint` (tsc) guidance.

## 0.0.3 — 2026-05-20

Hardening release: closes a render-blanking crash triggered by nested
types, tightens the calibrator's edge verification, and trims framework
plumbing from the prompt's external-call output. No new user-facing
features. Pure recommended upgrade from 0.0.2.

### Fixed
- **Webview no longer blanks when an edge points at a nested type.**
  The DocumentSymbol API returns a tree; the symbol provider's flatten
  walked children unconditionally, so nested types (a private record
  like `ChunkHit` inside RecallQuery.cs, an inner class) showed up in
  the flat in-file symbol list. The calibrator matched a `calls` target
  against the nested symbol and emitted the edge as verified=true; the
  aggregator's short-circuit then pushed it without checking whether
  the target was actually a graph node. cytoscape threw "Can not create
  edge with nonexistent target" on the first dangling reference and
  aborted the entire render — the panel fell back to the mockup fixture
  ("14 CLASSES · 51 METHODS") with no graph at all. Three layers of
  defense now:
  - `vscode-symbol-provider.flatten()` tracks depth and tags children
    with `topLevel: false`.
  - `calibrator.calibrate()` filters in-file symbols to top-level only
    before `bestSymbolMatch`. `CALIBRATOR_VERSION` bumped v2 → v3 so
    cached AnalyzeResults built under the old logic invalidate.
  - `aggregator` only short-circuits a verified=true edge when its
    target is already in `nodeIdSet`; otherwise the edge falls through
    to the same lookup + ghost-creation path as unverified edges.
  - `graph-adapter` drops any edge whose endpoint isn't in
    `validNodeIds ∪ validExtIds` before shipping to the webview, so
    a future regression in either layer above cannot blank the panel.
- **`npm run package` no longer ships a stale bundle.** The script only
  ran `vsce package`, leaving an out-of-date `dist/extension.js` from
  the previous build. Adding `npm run build &&` to the package script
  plus a `vscode:prepublish` hook closes the gap — a freshly-bumped
  PROMPT_VERSION / CALIBRATOR_VERSION in source now always reaches the
  VSIX.

### Changed
- **Prompt v3.3 → v3.4: skip framework infrastructure in
  `external_calls`.** Previously, every `IServiceCollection` /
  `IConfiguration` / `ILogger` / `CancellationToken` / generic
  `Exception` ref leaked into the graph as an `ext:*` edge. v3.4
  explicitly enumerates the skip list (DI, logging, async primitives,
  generic exceptions, ASP.NET Core HTTP plumbing) and the keep list
  (Dapper, Npgsql, IDbConnection, Pgvector, IHttpClientFactory,
  third-party SDKs, workspace contracts). On the lumen `apps/api/src`
  corpus this dropped 80+ framework edges that were drowning out real
  inter-module references; eval F1(edges) moved -0.30 vs the v3.3
  baseline as expected, then back to 1.00 after re-snapshotting golden.

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
