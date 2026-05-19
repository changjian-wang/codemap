# Architecture Decision Records

Short, dated notes that explain *why* CodeMap has its current shape. Each ADR has:

- **Context** — what we were trying to do
- **Decision** — what we chose
- **Consequences** — the upside and the cost we accepted
- **Alternatives considered** — what we ruled out and why

| # | Title | Status |
|---|-------|--------|
| [001](001-repo-level-mvp.md) | Repo-level MVP, not method-level | Accepted |
| [002](002-class-as-node-uml.md) | Class as the node, methods inlined as UML compartments | Accepted |
| [003](003-chat-as-orchestrator.md) | Chat participant as the orchestrator (no command palette) | Accepted |
| [004](004-calibration-layer.md) | Separate calibration layer (LLM ↔ LSP cross-check) | Accepted |

When you make a non-obvious shape change, add a new ADR rather than rewriting an old one. Keep them short — one screen of prose is the right size.
