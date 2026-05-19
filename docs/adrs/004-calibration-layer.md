# ADR 004: Separate calibration layer (LLM ↔ LSP cross-check)

**Status:** Accepted
**Date:** 2025-02

## Context

The LLM-produced graph is *useful but not trustworthy*. Common failure modes we observed during prototyping:

- **Hallucinated calls** — `AuthController.Login` reportedly calls `TokenIssuer.Issue`, but `TokenIssuer.Issue` does not exist; the LLM extrapolated from the method name.
- **Drifted line numbers** — the LLM emits `line: 42`, but the actual symbol is at `line: 47` (the LLM was reading a slightly older revision; or, more commonly, miscounted).
- **Missed external calls** — `JsonSerializer.Deserialize` is omitted because the LLM treats BCL types as "implementation noise".

Naively trusting any of these renders `/why` useless. But running a full static analyzer (Roslyn, ts-morph) just to confirm what the LLM said throws away the speed advantage of using an LLM in the first place.

## Decision

**A thin `calibration/` layer cross-checks every LLM-emitted graph against the language server** (`executeDocumentSymbolProvider`, `executeWorkspaceSymbolProvider`). It does **not** replace the LLM output — it annotates it.

For each node:

- `verification: 'verified' | 'partial' | 'unverified'`
- `verificationDetails: { droppedCalls: [...], droppedExternalCalls: [...], lspNotReady: bool, rangeAdjusted: bool, reason?: string }`

Rules:

1. **Lookup is cheap** — each LSP query is sub-millisecond once the index is warm. We can afford one per edge.
2. **LSP not ready ≠ hallucination** — if `executeWorkspaceSymbolProvider` returns `undefined` we surface `lspNotReady: true` rather than downgrading the node to `unverified`. The user is told "provisional, LSP not warm yet".
3. **Dropped calls become first-class output** — `droppedCalls` and `droppedExternalCalls` are surfaced in `/why <node>`. The user sees *exactly what the LLM said that LSP could not corroborate*, not a vague confidence score.
4. **`rangeAdjusted: true`** when we successfully relocated the symbol to the right line (off-by-N corrections); the node stays verified but is flagged.

External calls are emitted as `ext:*` edges regardless of LSP outcome — BCL / NuGet types are routinely absent from the workspace symbol index, so a miss is not proof of hallucination. We *do* record the miss to `droppedExternalCalls` so `/why` can transparently say "could not corroborate this one".

## Consequences

**Positive**

- The user always sees *why* a node is partial / unverified. No mystery-meat confidence bars.
- We can ship the LLM output even when the LSP is still indexing — degraded mode is a real product mode, not a crash.
- Adding a new check (e.g. "method signature does not match") fits in the same `verificationDetails` shape.

**Negative**

- A small but real maintenance burden: changes to the LSP behavior (e.g. how C# extension resolves generic methods) can shift counts. Mitigated by the unit tests in `test/unit/calibrator-*.test.ts` and the golden eval harness in `eval/`.
- The calibrator is a stateful intermediate step — we cannot stream nodes to the WebView before calibration finishes. We accept this; chat shows a "calibrating..." progress message.

## Alternatives considered

1. **Trust the LLM** — rejected, see Context.
2. **Replace the LLM with a full static analyzer** — rejected, loses intent/risk narration which is the actual product differentiation.
3. **Run the calibrator only on user-flagged nodes** — defers the cost but means the *first* `/why` after generate is slow. Worse UX than the current "calibrate everything, batch".
