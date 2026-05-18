# CodeMap

> Interactive call graph + reading guidance for AI-generated code, packaged as a VS Code extension.

**Status**: pre-implementation. Product form is locked via the [v3 mockup](docs/mockups/lumen-backend-v3.html); the [v3 development plan](docs/plan/development-plan-v3-repo-level.md) is the active source of truth.

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
│   ├── mockups/                                       # canonical UI references
│   │   ├── lumen-backend-v3.html                       # ← product baseline
│   │   └── generic-repo-v3.html
│   ├── plan/
│   │   ├── development-plan-v3-repo-level.md           # ← active plan
│   │   └── development-plan-v2-single-file.md          # superseded
│   └── adrs/                                          # to be added (4 core ADRs)
├── src/                                               # to be scaffolded (W1)
└── eval/                                              # golden samples + score.ts (W2)
```

## Tech stack

- VS Code Extension API (≥ 1.90), Chat Participant API
- `vscode.lm` — calls GitHub Copilot models, no external API key
- LSP commands (`executeDocumentSymbolProvider`, `executeWorkspaceSymbolProvider`, `executeDefinitionProvider`)
- Cytoscape.js + dagre layout for the UML graph
- TypeScript, esbuild

## Next steps

Follow the 5-week schedule in [`docs/plan/development-plan-v3-repo-level.md`](docs/plan/development-plan-v3-repo-level.md):

1. **W1** — scaffold extension + chat participant + WebView UI mirroring the v3 mockup, fed by fixture data
2. **W2** — workspace scanner, single-file analyzer, calibrator
3. **W3** — aggregator + cross-file edges, real `@codemap` end-to-end on lumen
4. **W4** — eval, prompt tuning, chat commands (`/scope`, `/focus`, `/why partial X`, `/explain unverified`)
5. **W5** — polish, ADRs, `.vsix`, internal beta

## License

TBD.
