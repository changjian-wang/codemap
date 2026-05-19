# ADR 001: Repo-level MVP, not method-level

**Status:** Accepted
**Date:** 2025-02

## Context

When we set out to build CodeMap, the obvious "demo-able" target was a *method-level* call graph: every method becomes a node, every method invocation becomes an edge. That's what most academic call-graph tools and IDE features (e.g. `Show Call Hierarchy`) produce.

For an LLM-driven product the cost calculus is different from a static analyzer:

- LLMs need to read the whole file to label a method's intent; doubling the granularity does not double the cost, it multiplies it by the average methods-per-class (~5–15 in C# / TypeScript projects we sampled).
- Method-level edges are noisy. A controller calling `_logger.LogInformation` produces edges that drown the architectural signal.
- Reading order (the W4 narrative feature) is meaningful at the class level — "read `AuthController` before `TokenIssuer`" — and uninteresting at the method level — "read `Login()` before `IssueToken()` *inside* `AuthController`".

## Decision

**Nodes are classes. Methods are inlined as a `methods[]` array on each node.**

- `CodeNode.id` is the class name (collisions disambiguated via bounded-context prefix).
- `CodeNode.methods[]` carries name, signature, line, intent, risks, calls, and `readState`. They render as expandable rows in the WebView.
- Edges are class-to-class. `calls` aggregates every cross-class method invocation; `external_calls` covers package / BCL references.

## Consequences

**Positive**

- Single LLM round-trip per file. The single-file analyzer asks for "every class in this file"; it never has to revisit.
- The W4 reading-order narrative ("read these 6 classes in this order to understand auth") is a natural product, not a derived one.
- Graphs stay legible. A 200-file repo produces ~150 nodes, not ~2,000.

**Negative**

- "Why does `Login()` fail when `IssueToken()` throws?" needs to be answered from `methods[]`, not from edge traversal. We accept this.
- Public-API change cost is high if we ever pivot. We mitigated by hiding the method-level data behind `CodeNode.methods` so the wire format does not need to change.

## Alternatives considered

1. **Function/method-level nodes** — rejected, cost & noise (see Context).
2. **File-level nodes** — too coarse. A single `Handlers.cs` could hold 5 unrelated handlers; collapsing them loses every architectural distinction `/why` is supposed to surface.
3. **Two-tier graph** (file → class → method) — adds rendering complexity for marginal value at MVP. Revisit post-W5.
