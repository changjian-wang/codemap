# CodeMap v0.1.0 development plan (v4)

> Generated from ADR-005. Each slice is end-to-end, independently verifiable, independently commit-able.
> Labels: `HITL` = needs a human in the loop (visual check, runtime probe, prompt tuning). `AFK` = mechanical, agent can run unattended.

---

## Phase 0 — Foundation

### 0.1 Cleanup & archive — AFK ✅

- Move v0.0.x code into `legacy/`. New `src/` keeps `extension.ts` + `chat/{participant,intent-router,scope}.ts` + `editor/jump-to-source.ts` + `shared/types.ts`.
- `extension.ts` and `chat/participant.ts` are stubs returning the rebuild notice.
- Drop `esbuild.js` vendor copy (cytoscape / dagre / elkjs); reintroduce in 1.1 with Pixi.
- `.vscodeignore` excludes `legacy/**` and the whole `docs/**`.
- Acceptance: `npm run build` exits 0. `npm test` passes (no tests yet, `passWithNoTests: true`).

### 0.2 Graph shape v2 contract — AFK ✅

- `src/shared/types.ts` — two-tier types with Conventions block locking Q1–Q3.
- `eval/samples/lumen-mini/fixture.json` — concrete fixture covering every edge case (class-id fallback, partial verification, `isShared`, external deps).
- Acceptance: TypeScript compiles the fixture against the contract (Phase 1.1 will load it).

### 0.3 Tech spike — HITL

Two independent prototypes runnable in parallel. Conclusions append to ADR-005 §7.1 / §7.2 before Phase 1 / Phase 2 start.

- **R1 — Pixi.js in VS Code webview.** Single-file spike under `tools/spikes/pixi-r1/`. Render `fixture.json` as plain circles + lines. Goals: confirm CSP, bundle size (<1 MB extension contribution), 30 fps at 100 nodes. **Delete the spike after the conclusion lands in ADR.**
- **R2 — Roslyn against `lumen.slnx`.** Single .NET console app under `tools/spikes/roslyn-r2/`. `MSBuildWorkspace.OpenSolutionAsync` + walk `INamedTypeSymbol` for `Lumen.Capture`. Goal: confirm `.slnx` opens, project-level analysis works on .NET 9 SDK. **Delete the spike after the conclusion lands in ADR.**

Per the `prototype` skill: one spike, one question, delete or absorb. No orphans in `main`.

### 0.4 Promote v2 draft to canonical — AFK ✅

- `git mv src/shared/types-v2.draft.ts src/shared/types.ts`.
- `git mv eval/samples/lumen-mini/fixture-v2.draft.json eval/samples/lumen-mini/fixture.json`.
- Update imports.
- Acceptance: `npm run lint && npm run build` green.

---

## Phase 1 — Pixi renderer (independent of Phase 2)

Each slice ships a runnable webview that consumes `fixture.json`. No orchestrator dependency yet — the fixture is hard-loaded.

### 1.1 Pixi bootstrap + fixture render — HITL

- Add `pixi.js` + `d3-force` to dependencies. Update `esbuild.js` to copy `pixi.js` umd to `dist/vendor/` (or bundle via ESM).
- New `src/webview/panel.ts` (rewritten from scratch). New `src/webview/scene/` with `bootstrap.ts` (`Application`), `node-renderer.ts`, `edge-renderer.ts`.
- WebView loads fixture; renders one circle per `MethodNode`, one line per `MethodEdge`. No layout yet (manual coords from fixture).
- Acceptance: open command `CodeMap: Show Last Graph` → fixture renders. 7 methods + 9 edges visible.

### 1.2 d3-force layout + swimlane grouping — HITL

- d3-force engine with class-as-cluster constraint (methods in same class attract).
- Swimlane backdrops per `boundedContext`, colored from a fixed palette.
- Acceptance: methods of `IngestUrlHandler` cluster; `capture` / `recall` / `shared` swimlanes are visually distinct.

### 1.3 Method-level interaction — HITL

- Hover → highlight incident edges + reveal docComment tooltip.
- Click method → pin focus; siblings dim.
- Click external dep (`ext:OpenAIEmbedder`) → opens reference panel listing call sites.
- Acceptance: focus / hover / unhover behaviour matches the docs/mockups screenshot baseline (kept in `legacy/docs/mockups/` for visual reference only).

### 1.4 Reading order + verification overlay — AFK

- Numbered reading order overlay following `CodeMapGraph.readingOrder`.
- Verification color: `verified` (green border), `partial` (yellow), `unverified` (red dashed).
- Acceptance: `AskByQueryHandler.HandleAsync` shows yellow border with droppedTargets tooltip.

### 1.5 Jump-to-source wiring — AFK

- Reuse `src/editor/jump-to-source.ts` (kept from v0.0.x — dependency-free).
- Double-click method → opens file at line.
- Acceptance: clicking on `IngestUrlHandler.HandleAsync` opens `apps/api/src/Capture/IngestUrlHandler.cs:42`.

---

## Phase 2 — C# Roslyn calibrator host (independent of Phase 1)

A standalone .NET project + JSON-RPC contract. Built and tested in isolation; the extension does not consume it until Phase 2.6.

### 2.1 dotnet tool skeleton + JSON-RPC transport — HITL

- New `tools/codemap-calibrator-csharp/` project. .NET 8 framework-dependent.
- StreamJsonRpc on stdin / stdout. `initialize`, `shutdown`, `ping` methods only.
- Acceptance: `dotnet run --project tools/codemap-calibrator-csharp` + manual stdin JSON-RPC ping responds.

### 2.2 MSBuildWorkspace + `.slnx` open — HITL

- Parse `.slnx` via `XDocument.Descendants("Project")` and call `MSBuildWorkspace.OpenProjectAsync(csprojPath)` per project. `OpenSolutionAsync` is unusable on `.slnx` — it throws `InvalidProjectFileException("No file format header found")` because Roslyn's solution parser still expects the classic `Microsoft Visual Studio Solution File` header (R2 finding, see ADR-005 §7.2). Skip the benign `ArgumentException` raised when a project is already loaded via transitive references.
- Surface diagnostics through JSON-RPC notifications (not exceptions).
- Acceptance: open `lumen.slnx`, return distinct project count + first project name. Note: cold start may be ~60 s on first run (NuGet restore + project graph build); Phase 2.5 must hide this behind a background warmup.

### 2.3 Method callee resolution — AFK

- Implement `resolveCallees(file, line, classId, methodName) → Callee[]` per the `CalibratorService` contract.
- Use `SemanticModel.GetSymbolInfo` on each `InvocationExpressionSyntax`.
- Acceptance: feed `IngestUrlHandler.HandleAsync` location → returns `WebContentExtractor.ExtractAsync` + `OpenAIEmbedder.EmbedAsync` + `ChunkStore.SaveAsync`.

### 2.4 IPC contract + error envelope — AFK

- Define `CalibratorRequest` / `CalibratorResponse` / `CalibratorError` Zod-equivalent schemas in `src/shared/calibrator-protocol.ts`.
- C# side has the matching DTOs.
- Acceptance: contract round-trips a synthetic request via integration test.

### 2.5 Subprocess lifecycle from extension — HITL

- Spawn / health-check / kill in `src/calibration/host/csharp-host.ts`.
- Graceful shutdown on extension deactivate.
- Auto-respawn on crash with backoff (max 3 attempts).
- Acceptance: `kill -9` the subprocess → next request triggers respawn → succeeds.

---

## Phase 2.5 — TS / JS calibrator (in-process)

### 2.6 ts-morph project loader — HITL

- Add `ts-morph` to dependencies.
- `src/calibration/typescript-calibrator.ts` implements `CalibratorService`.
- Reuses `Project` per workspace folder; respects `tsconfig.json`.
- Acceptance: load `codemap` repo itself; resolve `registerChatParticipant` callees from `src/extension.ts`.

### 2.7 Method callee resolver — AFK

- Implement `resolveCallees` for TS/JS using `findReferences` on identifiers within method body.
- Handle class methods, arrow-function properties, and stand-alone functions.
- Acceptance: parity test set returns same shape as C# implementation.

---

## Phase 2.6 — `CalibratorRegistry`

### 2.8 Interface + language routing — AFK

- `src/calibration/registry.ts` exports `getCalibrator(languageId)`.
- Routes `csharp` → `CSharpCalibrator`, `typescript`/`javascript`/`typescriptreact`/`javascriptreact` → `TypeScriptCalibrator`.
- Unknown language → `NullCalibrator` (returns empty callees + verification `unverified`).
- Acceptance: unit test enumerates language ids → expected calibrator class.

---

## Phase 3 — Orchestrator rewrite + wire-up

### 3.1 LLM analyzer producing v2 shape — HITL

- New `src/orchestrator/` (built from scratch — old one lives in `legacy/`).
- Single-file analyzer emits v2 `ClassNode` + `MethodNode` directly (no class-only intermediate).
- Acceptance: feed `IngestUrlHandler.cs` → returns ClassNode with `methodIds: ['IngestUrlHandler.HandleAsync', …]` + MethodNodes.

### 3.2 BC classifier + entry detector port — AFK

- Port from `legacy/src/orchestrator/bc-classifier.ts` and `legacy/src/llm/entry-detection/` with minimal v2-shape adjustments.
- Acceptance: lumen-mini fixture's BC assignments match the v2 fixture's `boundedContext` field.

### 3.3 Chat participant rewire — HITL

- Replace `src/chat/participant.ts` stub with intent-routed handler.
- Reuse `src/chat/intent-router.ts` + `src/chat/scope.ts`.
- Re-implement `/scope`, `/focus`, `/why`, `/explain`, `/eval`, `/entries`.
- Acceptance: `@codemap` in chat → all six commands respond with v2-shaped data, webview opens correctly.

### 3.4 New eval baselines — HITL

- Implement v2 scorer (uses `classEdges` derived view for class-level baselines + `methodEdges` for method-level).
- Generate fresh `lumen-v0.1.0-actual.yaml` baseline.
- Decide: delete `legacy/eval/baselines/` or keep as historical reference (recommend keep).
- Acceptance: `npm run eval` produces a baseline file with precision / recall / F1 numbers; numbers are not worse than `legacy/eval/baselines/lumen-v0.0.8-actual.yaml` on the shared subset.

---

## Notes

- Slices marked HITL should not be run unattended.
- Each slice is one commit (or one PR if it grows). Commit body labels: `slice: HITL` or `slice: AFK` per the `vertical-slice` skill.
- If a slice grows beyond ~400 LOC or starts to span two phases, split before committing.
