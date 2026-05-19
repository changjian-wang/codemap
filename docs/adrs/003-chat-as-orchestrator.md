# ADR 003: Chat participant as the orchestrator (no command-palette entry point)

**Status:** Accepted
**Date:** 2025-02

## Context

VS Code extensions traditionally expose their entry points through the **command palette**: `> CodeMap: Generate Map`, `> CodeMap: Focus On…`, etc. That's the path of least surprise for a typical developer-tool extension.

CodeMap is not a typical developer-tool extension. Every interesting action requires:

- A natural-language target ("focus on the auth flow", not "focus on `AuthController`").
- A working LLM connection.
- A graph to operate against — `/why` and `/focus` only make sense after a `/scope` or `@codemap generate workspace` has run.
- A turn-based memory (last graph, last scope, last reading order).

Command palette gives us none of those for free. We would end up reinventing chat — input boxes, follow-up prompts, scroll-back history.

## Decision

**The chat participant `@codemap` is the single orchestrator.** All user actions flow through:

```
@codemap                         → generate workspace map
@codemap /scope <query>          → generate scoped map
@codemap /focus <classId>        → render ±1-hop subgraph from last map
@codemap /why <classId>          → explain verification + reasons for a node
@codemap /explain unverified     → list partial/unverified nodes with reasons
```

There is **no** command palette entry, **no** activity-bar view, **no** status-bar item. The only command we register is `codemap._internal.showGraph`, which the chat participant invokes to open the WebView.

## Consequences

**Positive**

- One mental model. The user types into chat; that's it.
- Turn memory comes from `workspaceState` keyed by `revHash` — natural to pair with chat history.
- Follow-up prompts work: `@codemap /why AuthController` after a generate is a natural flow, not a multi-step wizard.
- Future model-router work (Sonnet vs. mini, see W2 plan) hooks cleanly into `vscode.lm.LanguageModelChat`. No translation layer.

**Negative**

- Hard dependency on `GitHub.copilot-chat`. We declare it in `extensionDependencies` and the extension will not activate without it.
- New users will not "discover" the extension by typing `> CodeMap` in the palette. We accept this — the README + marketplace listing point at the chat usage.

## Alternatives considered

1. **Command palette + chat both** — rejected, two entry points means two state machines (palette-driven graph state vs. chat-driven graph state). Doubles the test surface for a feature that has no demand.
2. **Activity-bar view as primary** — rejected, the view would need its own input UI, defeating the "chat is the UI" argument.
3. **CLI-only (headless)** — out of scope for v0.
