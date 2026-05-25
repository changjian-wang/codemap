# Changelog

All notable changes to this extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Method-as-node redesign (slice 1). Webview switches from class-as-node
UML to method-as-node compound graph: each class becomes a Cytoscape
compound parent (swimlane) and each method becomes a child node. Edges
are emitted at the method level (using each method's `calls` /
`externalCalls` attribution), with class-level edges retained as a
fallback for unverified / promoted-external links. Tap on a method
node sets focus; tap on a class compound selects it for Details.
Filters and fold (double-tap class) are rewired for the new node
classes (`.cls` / `.method` / `.ext`).

The mockup file is renamed to drop the `lumen-` prefix:
`docs/mockups/lumen-backend-v3.html` → `docs/mockups/codemap-view.html`.
Reflected in `panel.ts`, `.vscodeignore`, `esbuild.js`, the v3
development plan, and `CONTRIBUTING.md`.

All Mode now reads as horizontal bc swimlanes. Before this change, All
mode dumped every class into one dagre LR slab where bc was encoded only
by node color — useful for "show me everything" but not for "where does
the capture pipeline live vs recall". The new layout post-processes
dagre's positions so each bc gets its own horizontal band (host on top,
then capture / recall, then shared), and `ext:*` nodes drop to a single
row at the bottom spread evenly across the canvas. Toggling back to
Focus mode restores the original dagre bezier edges, so the redesign
costs nothing when you're zoomed in on one entry.

Focus Mode also drills per-method now. v0.0.8 set focus on a method but
BFS'd from the owning class, so clicking different methods of the same
entry class produced identical subgraphs — the user saw the panel
selection move but the graph never changed. Two layers had to change:
the webview now drives the focus set from each entry's
`reachableClassIds`, and the adapter now computes those per method
(seeded from the method's `calls`) instead of giving every method on
an entry class the same class-level BFS. Clicking
`RecallEndpoints.Search` vs `RecallEndpoints.Ask` now yields visibly
different subgraphs.

Scope: webview only. The extension host, analyzer, and LSP calibrator
are unchanged. All edits live in `docs/mockups/codemap-view.html`,
which is consumed both standalone and by the webview panel.

### Added
- **`docs/mockups/codemap-view.html` — `applySwimlanes()`.** After
  dagre lays out the full graph, classes are bucketed into the four
  fixed bc slots (`host` / `capture` / `recall` / `shared`) used by
  the data layer's bc remap, and re-stacked at a fixed pitch within
  each band. Band heights are computed independently per band so a
  dense band doesn't force everyone into stretched spacing. `ext:*`
  nodes skip banding and get pinned to a single horizontal row below
  the last band, spread evenly across the core layout's X span.
- **`fitWithTopReserve()` helper.** Manual zoom + pan replacing
  `cy.fit()` for All mode — reserves 110px at the top so the host
  band's topmost node (typically `Program`) clears the floating
  Focus / All / Depth toolbar overlay.
- **Edge taxi routing.** While banded, edges switch to cytoscape's
  `taxi` curve style with horizontal direction. Dagre's per-edge
  control points were captured pre-translation and produce visually
  broken curves once nodes are translated, so taxi recomputes
  L-shaped paths at render time.

### Changed
- **`setMode()` — exit hook for swimlanes.** Toggling away from All
  mode calls `clearSwimlanes()` to remove the taxi edge style, so
  Focus mode reverts to the original `unbundled-bezier` curves that
  use dagre's control points.
- **`renderOutline()` — stable order, no depth-based re-rank.** v0.0.8
  re-sorted entry classes by their forward call-depth from the focus
  class on every click, which made the clicked entry jump to the top
  of the panel and disoriented the reader who lost the visual anchor
  point of the tree. Depth badges (`here` / `+N` / `—`) still render
  but they no longer drive ordering — `highlightOutlineMethod()`
  handles active feedback via a row highlight in place.
- **`focusSetForCurrent()` — method-rooted BFS.** New helper called
  from `applyFocusInternal()`. When the active focus carries a
  `methodName` and an `ENTRIES` row matches `(classId, methodName)`,
  the focus set is `{classId} ∪ entry.reachableClassIds` instead of
  the class-rooted depth BFS, so the graph reflects what that specific
  method calls. `getDepthsFromFocus()` mirrors the restriction: its
  BFS through class adjacency stops at edges leaving the method's
  reach, so the outline depth badges line up with the visible graph
  rather than the broader class-level fan-out.

### Fixed
- **`layoutFocus()` no longer pins shared classes below the chain.**
  `positionSharedRow()` was a holdover from the All mode layout — in
  focus mode it forced any shared callee (e.g. `EventStore`, reached
  from both `IngestUrl` and `List`) to a Y position 90px below the
  rest of the subgraph. For sparse subgraphs like `CaptureEndpoints.
  List` (one shared callee, two ext deps), the result was a near-empty
  canvas with the only callee floating at the bottom. Removed; dagre
  LR handles the placement.
- **Right details panel syncs to the focused class.** `selectClass()`
  was the only path that re-rendered `#cardBody`, so clicking an
  outline method left the panel stuck on whatever was selected first
  (typically the default-entry `Program` on initial load). Extracted
  the panel update into `syncDetailsTo(id)` and called it from
  `applyFocusInternal()` after `layoutFocus()` so the panel always
  reflects the class owning the currently focused method. The new
  helper deliberately skips `focusNodeOnGraph()` — `layoutFocus()` has
  already fit the subgraph to the viewport, and animating to center on
  a single node would override that.
- **`computeFocusModeMetadata()` builds per-method reachable sets.**
  Previously every method on the same entry class shared one
  class-level BFS result, so clicking different methods produced
  identical subgraphs on real analyzer output (the mockup fixture
  hand-wrote divergent `reachableClassIds`, masking this on synthetic
  data). The reach for each entry method is now seeded from that
  method's `calls` (LLM-attributed targets, narrowed to valid class
  ids) and expanded through the shared class adjacency. Methods with
  no per-method `calls` fall back to the class-level reach, so
  analyzers that skip per-method attribution still get a sensible
  default.

## 0.0.8 — 2026-05-22

Focus Mode redesign. Closes #2. The webview's READING ORDER panel was
a flat alphabetical method list and the graph rendered every class in
one dagre slab — two unrelated views you had to mentally cross-reference.
This release turns both into one entry-method-driven navigator: pick
an entry method, the graph zooms to the subgraph reachable from it at
depth N (1 / 2 / 3 / ∞), and the outline reorders itself so reading
distance from the chosen entry runs top-to-bottom. Browser-style
Back / Forward arrows and a Focus / All toggle let you sweep through
entry points without losing context.

Scope: webview + eval only. The extension host, the analyzer, the LSP
calibrator and the orchestrator are unchanged. The mockup at
`docs/mockups/codemap-view.html` and the data adapter in
`src/webview/graph-adapter.ts` carry the entire focus-mode change; the
eval scorer gets a small bare-vs-FQN canonicalisation that removes a
known double-counting noise source from precision/recall numbers
without re-running the LLM.

### Added
- **`src/webview/graph-adapter.ts` — `computeFocusModeMetadata`.** Pure
  derivation over the existing `MockupData` shape: entry methods
  grouped by bc, a forward-BFS reachability map per entry, and the
  "shared class" set (classes reached by ≥30% of entries). Exposed
  on `window.__CODEMAP_DATA__.entries / shared` so the webview never
  re-walks the graph at runtime.
- **READING ORDER — 3-level entry tree.** Replaces the flat method
  list with `bc → entry class → method`. Entry-class headers have
  their own collapse caret; method rows show name + a one-line intent
  subtitle. Clicking a method focuses on it.
- **Focus subgraph navigation.** Clicking a method runs a depth-N BFS
  over `calls` edges from its class, hides every other node and edge,
  re-runs dagre on the visible subset, and pins shared classes to a
  bottom band so the call chain stays vertically aligned. Depth is
  controlled by a 1 / 2 / 3 / ∞ slider in a new focus bar above the
  graph.
- **Focus / All toggle.** `All` re-runs dagre on the full graph (taxi
  routing intact) so you can sanity-check the wider context; `Focus`
  restores the last entry without re-selecting. Clicking an outline
  method while in All mode auto-switches back to Focus.
- **Back / Forward history.** 50-entry stack of `(classId, methodName)`
  pairs, browser-style: `setFocus` pushes, mid-stack navigation drops
  the forward branch, depth changes don't pollute the stack.
- **BC breadcrumb chip.** `bc › Class . method` in front of the
  focus-bar class label, filled with the bc semantic color
  (host / capture in khaki / teal with dark text; recall / shared in
  purple / blue with white text). Dimmed in All mode.
- **Depth-from-focus outline badges + ordering.** Each entry-class row
  gets a small badge — `here` (current focus, accent fill), `+N`
  (reachable in N hops), or `—` (unreachable from current focus, row
  dimmed to opacity 0.5). Entries sort by depth ascending within their
  bc group; All mode hides badges and falls back to `readingPriority`
  sort.
- **`eval/score-cli.ts` — accepts YAML actuals** (detection by file
  extension via the already-installed `yaml` package). Removes the
  JSON-conversion step for every webview "Export → YAML" fixture.
  `eval/baselines/` seeded with the v0.0.6 lumen actual.

### Changed
- **`src/eval/score.ts` — bare-vs-FQN `ext:` canonicalisation.** Within
  the union of golden + actual `ext:` targets (post
  `ignoreEdgeToPrefixes` filter), two targets alias iff they share
  the same last dot segment AND at least one side is bare. Longest
  form in the alias bucket wins as canonical; lexicographic tiebreak
  for determinism. All-FQN buckets are left alone so distinct
  namespaces with the same type name never collide. On the lumen
  `apps/api/src` v0.0.6 baseline this collapses one
  `EvalHostBuilder → ext:AssemblyMarker` double-count (Edges F1
  0.916 → 0.920). Small headline gain; real value is a noise-free
  baseline for prompt-side experiments.

### Fixed
- **Shared-class node label no longer overflows its compact box.** The
  Slice 3 `.shared-cls` style forces a 100×32 pill but inherited
  `node.cls`'s full multi-line label — title + every method row. The
  overflow was invisible at idle (1px grey dashed border, opacity 0.6
  against the dark canvas) but glaring on selection: `node:selected`
  drew a thick blue ring around the 100×32 box while the title and
  trailing methods floated outside it. Shared nodes now show only the
  bare class id with `text-wrap: ellipsis`; full method lists remain
  accessible via the Details pane.

## 0.0.6 — 2026-05-21

Precision pass. v0.0.5 reached `lumen/apps/api/src` Edges F1=0.87 with a
clean recall (0.97) but a precision floor (0.79) the v0.0.5 release notes
already flagged for follow-up. This release lifts F1 to **0.92** (P=0.87,
R=0.97) and Nodes F1 to a perfect **1.00** on the same target by removing
two concentrated noise sources and adding one new cross-file signal,
without re-opening the recall trade we paid off last release.

The investigation took three loops. A first prompt-only spike (v3.8 —
hand the LLM a list of internal namespace roots so cross-file workspace
types stay in `external_calls` rather than getting mis-categorized) gave
+0.01 — disappointing but harmless, so it stayed. A second calibrator-side
spike that dropped bare-name `external_calls` entries before they reached
the aggregator (v6, then a narrowed v7) tanked Edges R to 0.29 by killing
the very same workspace-type bare names v3.8 was trying to promote.
Diagnosis then shifted from "bare names" to "where do the noise edges
actually come from" — and the answer was synthetic
top-level-statements `Program` nodes (`Lumen.Host.Program` and
`Lumen.Eval.Program`) dragging in roughly twenty extra out-edges each.
The third loop drops those nodes in the aggregator with a deterministic
file-path heuristic and rolls v6/v7 all the way back, with
`CALIBRATOR_VERSION` bumped to `v8` so the polluted cache is invalidated.

Net on `lumen/apps/api/src` against v0.0.5:

| Metric    | v0.0.5 (v3.7.1) | v0.0.6 (v3.8 + v8) |
| --------- | --------------- | ------------------ |
| Nodes P/R | 0.98 / 0.99     | 1.00 / 0.99        |
| Nodes F1  | 0.99            | **1.00**           |
| Edges P/R | 0.79 / 0.97     | 0.87 / 0.97        |
| Edges F1  | 0.87            | **0.92**           |

Recommended upgrade from 0.0.5 for any .NET 6+ workspace that uses
top-level statements in `Program.cs`. Other languages see the smaller
improvement from the v3.8 namespace hint and the new `/eval` diagnostic.

### Added
- **`src/orchestrator/internal-namespace-detector.ts`** (`PROMPT_VERSION
  v3.8`) — derives the list of internal namespace roots from scanner
  output (e.g. `["Lumen.Host", "Lumen.Modules.*", "Lumen.Shared.*"]`),
  folded into the per-file user message so the LLM stops emitting
  cross-file workspace types as `ext:*`. The hint is also part of the
  AnalyzerCache key so changing the workspace shape produces correct
  cache misses.
- **`/eval` diagnostic — extra edges** — the `/eval` output now lists
  up to 20 false-positive edges (next to the existing missing-edges
  block). Cheap to render, decisive when chasing precision regressions
  — without it the v3.10 root cause (synthetic Program nodes) would
  have stayed invisible behind aggregate P numbers.

### Changed
- **`src/orchestrator/aggregator.ts` — synthetic Program node filter.**
  In .NET 6+ a `Program.cs` containing only top-level statements has no
  explicit `class Program` declaration but the LSP/LLM still report
  one. The aggregator namespace-qualifies it
  (e.g. `Lumen.Host.Program`) and the resulting node plus every
  wire-up out-edge (`AddCaptureModule`, `MapRecallEndpoints`, ...) is
  pure noise against any reasonable golden wiki. We now drop the node
  and every in/out edge it touches via a file-path heuristic
  (basename = `Program.cs`, short id = `Program`). Deterministic,
  FS-free, easy to revert per-workspace if anyone actually does write
  an explicit `class Program` in `Program.cs`.
- **`src/llm/prompts.ts` — `PROMPT_VERSION` v3.7 → v3.8.** Adds the
  internal-namespace-roots hint; otherwise no behavioural change.
- **`src/calibration/calibrator.ts` — `CALIBRATOR_VERSION` v5 → v8.**
  The intermediate v6 (blanket bare-name `external_calls` drop) and v7
  (narrow v6 to verb-prefix bare names) never shipped — both regressed
  recall worse than they helped precision, and the actual fix lives in
  the aggregator. v8 reverts to v5's "accept every well-formed
  `external_calls`" semantics; the version bump alone invalidates any
  v6/v7 cache entries from prerelease VSIXes.

### Fixed
- **`Lumen.Host.Program` and `Lumen.Eval.Program` no longer appear as
  extra nodes** on .NET 6+ workspaces, and their roughly twenty
  spurious out-edges (`Program → ext:WebApplication.CreateBuilder`,
  `Program → DatasetLoader`, `Program → AddCaptureModule`, ...) are
  gone with them. This is the headline F1 win.
- **`EvalHostBuilder → ext:AddCaptureModule` and ~8 similar edges**
  that v6/v7 had erroneously deleted at the calibrator level are
  restored, lifting Edges R back to 0.97 from the v3.9 disaster level
  of 0.29.

### Known issues
- The LLM still over-emits "type-only" references as `calls` edges —
  return types, parameter types, generic arguments, implements
  clauses (`EnrichmentStore → IEnrichmentStore`,
  `CaptureModuleServiceCollectionExtensions → IEventStore`, ...). On
  lumen these account for roughly half of the remaining 31 extras and
  are the largest remaining target for v0.0.7+.
- Bare vs fully-qualified `ext:` names can split one logical edge
  across the missing/extras buckets (e.g.
  `ext:AssemblyMarker` predicted vs
  `ext:Lumen.Modules.Capture.AssemblyMarker` in the golden). Worth a
  scorer-side normaliser in eval rather than another prompt round.

## 0.0.5 — 2026-05-21

Recall pass. v0.0.4's v3.5 prompt spike traded recall for precision —
correctly tagging entry points but losing two thirds of the non-entry
nodes on `lumen/apps/api/src` (nodes R 0.99 → 0.67). This release puts
the recall back without giving up the entry-point semantics, and adds
a small scorer change so the eval numbers stop being dominated by BCL
plumbing.

Two architectural changes drive it. First, the monolithic entry-point
prompt section is decomposed into per-language rule files
(`src/llm/entry-detection/rules/{dotnet,python,node}.ts`) composed with
five universal blocks; `PROMPT_VERSION` is now `v3.6` and
`CALIBRATOR_VERSION` is now `v5`. Second, every per-file LLM analysis
now sees scanner-derived cross-file context — bounded context bucket,
whether the file is an entry point, and the list of in-skeleton files
that statically import it — folded into the user message and into the
AnalyzerCache key so changing scope produces correct cache misses
(`PROMPT_VERSION v3.7`). The scoring change (`v3.7.1`) is purely an
eval-side feature: golden samples may now declare
`ignoreEdgeToPrefixes`, and the scorer strips those prefixes from both
expected and actual before computing P/R/F1.

Net on `lumen/apps/api/src` against the cached v3.5 baseline:

| Metric    | v0.0.4 (v3.5) | v0.0.5 (v3.7.1) |
| --------- | ------------- | --------------- |
| Nodes P/R | 0.99 / 0.67   | 0.98 / 0.99     |
| Edges P/R | 0.93 / 0.78   | 0.79 / 0.97     |
| Edges F1  | 0.85          | 0.87            |

Edge precision regressed because the LLM still over-tags some internal
classes as `ext:*` (e.g. `ext:Lumen.Modules.Capture.AssemblyMarker`);
that fix is queued for v0.0.6 as a workspace-agnostic
internal-namespace hint. Pure recommended upgrade from 0.0.4 for any
codebase with >20 source files.

### Added
- **`src/llm/entry-detection/`** — per-language rule files
  (`rules/dotnet.ts`, `rules/python.ts`, `rules/node.ts`) plus five
  universal rule blocks (no entry, public_api hardening, synthesized
  Program for top-level statements, entry_meta strict mapping,
  workspace-hints). Adding a new language is one file in `rules/`.
  Composed by `composer.ts` into the entry-point section of the
  system prompt.
- **Scanner cross-file hints in the LLM user message.**
  `workspace-scanner.ts` now exposes `ScanResult.inbound: Map<string,
  string[]>` built during BFS and filtered to skeleton membership on
  both sides. The orchestrator threads `boundedContext`,
  `isEntryPoint`, and `inboundImports` into each per-file analyzer
  call; `prompts.ts:buildUserMessage` renders them as a `Workspace
  Hints:` block. A non-empty `inboundImports` is a hard rule against
  tagging the file as `public_api`.
- **`AnalyzerCache.key` gained a `hintSalt` parameter.** The salt
  format is `bc:${bucket}|entry:${0|1}|in:${sortedInbound.join(',')}`,
  so two scopes that produce different cross-file context for the
  same file get different cache keys.
- **`GoldenSample.ignoreEdgeToPrefixes?: string[]`.** Edge-target
  prefixes that should be stripped from BOTH expected and actual edge
  sets before scoring. Use for BCL / common infra noise (`ext:System`,
  `ext:Microsoft`, `ext:Dapper`, …) so the metric reflects business
  edges only.

### Changed
- **`PROMPT_VERSION`** `v3.5` → `v3.7` and **`CALIBRATOR_VERSION`**
  `v4` → `v5`. AnalyzerCache invalidates entries from the v3.5
  prompt automatically; symbol-provider cache invalidates entries
  from the v4 calibrator. Existing `.codemap/` GraphStore values
  are not affected.
- **Calibrator strips `kind=*` prefix from entity-form symbol
  probes** before matching against the LSP symbol table, so
  `kind=class:Foo` correctly resolves to `Foo`. Fixes the v3.5
  spike's false-positive `unverified` on every kind-tagged probe.

### Fixed
- *(none — this is a feature release.)*

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
  118 KB `codemap-view.html` design reference and the editable SVG
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
