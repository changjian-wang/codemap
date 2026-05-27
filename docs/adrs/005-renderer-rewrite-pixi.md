# ADR-005 — Pixi.js renderer + multi-language calibrator rewrite

**Status**: Accepted
**Date**: 2026-05-27
**Supersedes (partial)**: ADR-001, ADR-002, ADR-003, ADR-004 — see §6.

## 1. Context

By v0.0.8 CodeMap had three structural problems that compound:

1. **Renderer black box.** The webview runs Cytoscape inside a static HTML mockup (`docs/mockups/codemap-view.html`) with hand-written Pass 2/3 layout JS. We are already paying the cost of writing layout ourselves, but inside a library we cannot extend cleanly. Iteration is slow and visual quality is capped by Cytoscape's defaults.
2. **Calibrator is asymmetric and unstable.** The C# path goes through `vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider' / 'vscode.executeReferenceProvider')`, which is C# Dev Kit speaking to Roslyn via an opaque channel. The TS path has no equivalent — there is no first-class extension API that exposes the TS Compiler graph. Result: per-language code paths drift, and the C# Dev Kit dependency intermittently breaks calibration in cold-start.
3. **Data model / render model split.** Eval baselines are class-level; the mockup synthesizes method-as-node at render time. The orchestrator and the renderer disagree about what a node is, and the synthesis lives in webview JS where it cannot be unit-tested.

We can no longer fix these by patching. The renderer, the calibrator, and the graph shape all need to move together.

## 2. Decision

Six core moves, replacing the v0.0.x stack:

1. **Renderer — Pixi.js + custom layout.** A WebGL 2D scene we control. d3-force is the default layout; ELK is the alternate for hierarchical views. The static mockup HTML is retired (lives under `legacy/docs/mockups/`).
2. **Graph shape — v2 two-tier.** `ClassNode` is a swimlane container, `MethodNode` is the first-class graph node. Contract is `src/shared/types.ts`; concrete shape is `eval/samples/lumen-mini/fixture.json`.
3. **Multi-language `CalibratorService` interface.** Every language uses its own native analyzer. The extension host never calls a language analyzer directly — it calls a `CalibratorService` implementation chosen by a `CalibratorRegistry` keyed on language id.
4. **C# calibrator — Roslyn via dotnet-tool subprocess.** A standalone .NET project hosts `MSBuildWorkspace` and exposes the `CalibratorService` contract over JSON-RPC on stdin/stdout. Distribution is framework-dependent — users need .NET 8+ runtime, we do not bundle the runtime.
5. **TS / JS calibrator — TS Compiler API + ts-morph, in-process.** No subprocess; the analyzer runs inside the extension host. Same `CalibratorService` interface as C#.
6. **Chat is the entry, but not the data model owner.** The chat participant still routes intents (Phase 3.3); the orchestrator owns the v2 graph; the renderer is a pure consumer of v2.

### 2.1 Pinned sub-decisions (Q1–Q8)

| # | Question | Decision |
|---|---|---|
| Q1 | Overload handling | Method id = bare `Class.Method`; overloads collapse to one `MethodNode`. Matches v0.0.6/7/8 baselines. |
| Q2 | Constructors | Orchestrator does **not** emit `MethodNode` for ctors. They surface in the detail panel via class range only. |
| Q3 | Class-id fallback in `MethodEdge.target` | When the calibrator resolves callee class but not method, target stays as the bare class id (no `ext:` prefix). Scorer counts this as a **full hit** against a golden's class-level edge. |
| Q4 | C# runtime distribution | Framework-dependent. Require .NET 8+ runtime on the user machine. Document in README. |
| Q5 (revised) | TS / JS analyzer | TS Compiler API + ts-morph, in-process. Symmetric with the principle in §2-3: no `vscode.commands` round-trip. |
| Q6 | Reading order granularity | Method ids (`CodeMapGraph.readingOrder: string[]`), not class ids. |
| Q7 | Eval backward-compat | `classEdges` is a **derived view** aggregated from `methodEdges` at the boundary. v0.0.6/7/8 YAML baselines remain scoreable without duplicate source of truth. |
| Q8 | C# project entry format | Require `.slnx`. Effective toolchain floor: **.NET 9 SDK** (for `.slnx` support) even though runtime stays at .NET 8. Implementation note: `MSBuildWorkspace.OpenSolutionAsync` does **not** parse `.slnx` on Roslyn 4.11 — the calibrator host parses the slnx XML itself and calls `OpenProjectAsync` per `<Project Path="…"/>` entry. Verified by R2 spike (§7.2). |

### 2.2 `CalibratorService` interface principle

The interface lives in `src/shared/` and is the only thing the orchestrator depends on. Each language implementation is interchangeable:

- `CSharpCalibrator` — talks to a Roslyn subprocess.
- `TypeScriptCalibrator` — runs ts-morph inline.
- Future languages add implementations, not orchestrator branches.

The extension host knows nothing about Roslyn, `MSBuildWorkspace`, ts-morph, or any analyzer-specific concept.

## 3. Alternatives considered

- **Keep Cytoscape, fix the rest.** Rejected — we have already outgrown its layout extensibility (Pass 2/3 hand-written), and the cost of running our own layout inside a library we cannot fork cleanly is higher than running it on Pixi where we own the scene.
- **Keep `vscode.commands` for both languages.** Rejected — C# Dev Kit dependency is unstable and TS has no symmetric command; the asymmetry was already a maintenance tax in v0.0.8.
- **In-process Roslyn via Edge.js / Node-API.** Rejected — adds native build complexity to the VSIX and forces us to track Roslyn ABI in two runtimes. Subprocess + JSON-RPC is the boring choice.

## 4. Consequences

**Positive**

- Single render technology, full visual control.
- Symmetric per-language calibrator story; new languages are additive.
- Graph shape lives in TypeScript types, not in webview JS — orchestrator and renderer agree.

**Negative / accepted cost**

- `legacy/` tree carries v0.0.x for reference until Phase 3.3 lands. Eval is broken until Phase 3.3.
- Toolchain floor rises: .NET 9 SDK + .NET 8 runtime + Node 18+.
- VSIX must spawn an external process for C# repos. Documented in `docs/plan/v4-plan.md` Phase 2.5.

## 5. Migration / archive plan

- All v0.0.x code under `legacy/src/`. Tests under `legacy/test/`. Eval baselines + samples under `legacy/eval/`. Old plans under `legacy/docs/plan/`. Mockups under `legacy/docs/mockups/`.
- v1 `src/shared/types.ts` → `legacy/src/shared/types.ts`. New canonical contract is `src/shared/types.ts` (promoted from `types-v2.draft.ts` in Phase 0.4).
- `src/extension.ts` and `src/chat/participant.ts` are stubs in Phase 0.1; rewired in Phase 3.3.
- `src/chat/intent-router.ts`, `src/chat/scope.ts`, `src/editor/jump-to-source.ts` are kept — they are dependency-free utilities the new stack will reuse.

## 6. Relationship to prior ADRs

| ADR | What survives | What is superseded |
|---|---|---|
| ADR-001 — repo-level MVP | Workspace-scoped graph; chat-as-entry premise | Cytoscape webview + static mockup; v1 single-tier graph shape |
| ADR-002 — class-as-node UML | Class as a structural unit (now as swimlane) | Class as the only first-class node |
| ADR-003 — chat-as-orchestrator | Chat is the entry, orchestrator owns the graph | Specific `/scope` `/focus` …` handler implementations (re-wired in Phase 3.3) |
| ADR-004 — calibration layer | Calibration concept; precision/recall scoring discipline | `vscode.commands` LSP calls; C# Dev Kit dependency; single LSP-only path |

## 7. Status checkpoints

- Phase 0.1 — Archive + stubs landed (this commit).
- Phase 0.2 — `types-v2.draft.ts` + `fixture-v2.draft.json` landed.
- Phase 0.3 — **Done 2026-05-27.** R1 and R2 spike conclusions logged in §7.1 / §7.2. Phase 1 / Phase 2 are now unblocked.
- Phase 0.4 — **Done 2026-05-27.** v2 drafts promoted to canonical (`src/shared/types.ts` / `eval/samples/lumen-mini/fixture.json`); v4-plan Phase 2.2 rewritten to use the slnx XML walk per R2.

### 7.1 R1 — Pixi.js in VS Code webview

Status: **Resolved 2026-05-27** (`tools/spikes/pixi-r1/`, kept as a Phase 1 reference impl).

Re-scope: the original acceptance ("100 nodes / 200 edges @ ≥30 fps") was answered immediately by a synthetic-graph benchmark and was never the real risk. The spike was pivoted (per the `prototype` skill — one prototype, one question, but the question can be sharpened) into a much harder bar: **render the actual v2 graph fixture at production-quality visual fidelity using only Pixi v8 primitives**, treating `legacy/docs/mockups/codemap-view-gv.html` (Graphviz/VS Code dark mockup) as the visual contract.

Result: Pixi v8 cleanly renders the full v2 schema variant matrix at 60 fps on `lumen-mini` (5 classes, 7 methods, 9 edges):

- BC bucket → fixed 3-column lane layout (capture | recall | ext); cluster cards with BC-tinted outlines (teal / pink-purple / dim).
- Class cards with `verification:partial` amber outline + status dot; ext / stub cards in italic when `unresolved`.
- Method pills with `+ methodName()` GV labels, `entry` methods marked by an amber ▶ inside left padding.
- Edges with three routing modes from one helper: same-lane vertical, forward L→R sankey bezier, reverse R→L cubic bezier with `p2.y === p3.y` to pin a horizontal endpoint tangent (so arrowheads enter the target pill cleanly even when the source is to the right).
- Attachment fanning so co-side edges on the same pill don't share a single endpoint.
- Pan / zoom / `r` reset / per-edge hover (12 px screen-px threshold over a 30-sample bezier polyline).

Implication for Phase 1: Pixi v8 + hand-written column layout + custom bezier routing is the right shape. The spike's `bezierForEdge` + `attachOff` + entry/partial styling logic all transplant directly to `src/webview/`. Two design lessons survive into Phase 1:

1. Edge routing must be **endpoint-aware** — multiple co-side edges need fanning, and reverse cross-lane edges need a separate code path so the endpoint tangent stays horizontal. A single sankey-style bezier for all edges is not enough.
2. Visual signals must be **geometrically distinct AND chromatically distinct** — `verification:partial` (class outline) and `entry method` both wanted amber rings and collided; entry got demoted to a triangle glyph and amber is now reserved exclusively for `partial`.

Remaining gap (the part R1 deliberately did **not** cover, deferred to Phase 1 implementation):

- VS Code webview integration: CSP / `nonce` discipline, `vscode-webview-ui-toolkit` interop, `acquireVsCodeApi()` message bridge.
- ESM packaging: the spike loads `pixi.js@8` from the jsdelivr ESM URL because that is the only path that keeps Pixi's internal extension graph intact; the production webview must vendor a build that survives the VS Code CSP without falling back to UMD.
- Layout for graphs larger than `lumen-mini` (≥ 50 classes): the current `colX + i * colW` placement breaks down once cards overflow vertically. Phase 1 will need within-column packing (or scroll-on-overflow).

### 7.2 R2 — Roslyn against `lumen.slnx`

Status: **Resolved 2026-05-27** (`tools/spikes/roslyn-r2/`, since deleted per `prototype` skill).

Result: `MSBuildWorkspace` on Microsoft.CodeAnalysis 4.11 + .NET 9 SDK 9.0.314 works against `lumen.slnx` **with a caveat**: `OpenSolutionAsync` throws `InvalidProjectFileException("No file format header found")` on `.slnx` because Roslyn's solution parser still expects the classic `Microsoft Visual Studio Solution File` header. The workaround is short and durable: parse the `.slnx` XML (a flat `<Solution><Folder><Project Path="…"/></Folder></Solution>`) and call `workspace.OpenProjectAsync(csprojPath)` per project. Transitive P2P references load automatically and dedupe by project name (with a benign `ArgumentException` when a project is already in the workspace — the spike just skips and continues).

Numbers from `lumen.slnx`: 18 `<Project Path/>` declared → 11 distinct projects loaded (7 already present via transitive references). Cold load (first run, includes NuGet restore + project graph build) took 67 s on the test machine; expected to drop sharply on warm runs. `GetCompilationAsync` returned a non-null `Compilation`, and walking `ClassDeclarationSyntax` produced 8 `INamedTypeSymbol`s in the inspected project. No fatal `WorkspaceFailed` diagnostics.

Implication for the implementation: the C# calibrator host owns slnx parsing (a 10-line `XDocument.Descendants("Project")` walk). This is captured in Q8's implementation note. Cold-start cost (67 s) is a UX concern — Phase 2.5 must make calibrator startup a background warmup, not a per-request blocker.

Core absorbed from the spike (the snippet the Phase 2.2 implementation will mirror):

```csharp
MSBuildLocator.RegisterDefaults();
using var workspace = MSBuildWorkspace.Create();
var doc = XDocument.Load(slnxPath);
var baseDir = Path.GetDirectoryName(slnxPath)!;

foreach (var project in doc.Descendants("Project"))
{
    var rel = project.Attribute("Path")?.Value;
    if (string.IsNullOrWhiteSpace(rel)) continue;
    var csproj = Path.GetFullPath(Path.Combine(baseDir, rel));
    if (!File.Exists(csproj)) continue;
    try
    {
        await workspace.OpenProjectAsync(csproj);
    }
    catch (ArgumentException)
    {
        // already loaded transitively; safe to skip
    }
}
// workspace.CurrentSolution now contains every reachable project
```
