# CodeMap

> Interactive call graph + reading guidance for AI-generated code, packaged as a VS Code extension.

**Status**: pre-implementation. Product form is locked via the v3 mockup; development plan is being rewritten for repo-level scope.

## Product shape (v3, locked 2026-05-18)

- **Repo-level analysis** — one shot for the whole workspace, not single-file
- **UML class nodes** — each node = a class, methods listed inside; double-click eventually drills into method-level subgraph
- **Chat-first orchestration** — `@codemap` Chat Participant is the primary entry point; scope narrowing and follow-ups happen in chat
- **LSP-calibrated** — every node and edge passes `executeDocumentSymbolProvider` / `executeWorkspaceSymbolProvider`; three-state verification (verified / partial / unverified) is a first-class UI signal
- **Dual eval metrics** — node P/R *and* edge P/R, scored against hand-authored golden samples

See [`docs/mockups/lumen-backend-v3.html`](docs/mockups/lumen-backend-v3.html) for the canonical UI reference, demonstrated on a real .NET 8 modular monolith (lumen).

## Repo layout (planned)

```
codemap/
├── docs/
│   ├── mockups/                  # canonical UI references (HTML)
│   │   ├── lumen-backend-v3.html
│   │   └── generic-repo-v3.html
│   ├── plan/
│   │   └── development-plan-v2-single-file.md   # superseded; v3 rewrite pending
│   └── adrs/                     # to be added
├── src/                          # to be scaffolded
└── eval/                         # golden samples + score.ts
```

## Tech stack

- VS Code Extension API (≥ 1.90), Chat Participant API
- `vscode.lm` — calls GitHub Copilot models, no external API key
- LSP commands (`executeDocumentSymbolProvider`, `executeWorkspaceSymbolProvider`, `executeDefinitionProvider`)
- Cytoscape.js + dagre layout for the UML graph
- TypeScript, esbuild

## Next steps

1. Rewrite the development plan for repo-level scope (supersedes the v2 single-file plan)
2. Scaffold the `yo code` skeleton, hook up `vscode.lm`
3. Build the workspace scanner (file BFS + LSP cross-file resolution)
4. Set up `eval/` golden samples scored on lumen-style mid-size repos

## License

TBD.
