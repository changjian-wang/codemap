# CodeMap

> Interactive UML-style call graph + reading guidance for AI-generated code, packaged as a VS Code chat participant.

**Status:** alpha (W1–W4 landed, W5 polish in progress). The product shape is locked by the [v3 mockup](docs/mockups/lumen-backend-v3.html) and the [v3 development plan](docs/plan/development-plan-v3-repo-level.md).

---

## What it does

CodeMap reads your workspace, asks Copilot to extract a class-level architecture map, cross-checks it against the language server, and renders it as an interactive UML diagram with a recommended reading order. It runs entirely inside VS Code chat — no external API key, no separate web app.

Try it after install:

```
@codemap                                  → generate a map of the whole workspace
@codemap /scope authentication            → narrow the map to one concern
@codemap /focus AuthController            → ±1-hop subgraph around one class
@codemap /why TokenIssuer                 → why is this node partial / unverified?
@codemap /explain unverified              → list every partial / unverified node
```

The graph opens in a side panel. Each node is a UML class box (header + methods + footer); edges are calls and external dependencies. Verification badges (✓ verified, ⚠ partial, ✗ unverified) come from a separate calibration pass against `executeDocumentSymbolProvider` / `executeWorkspaceSymbolProvider`.

## Key properties

- **Repo-level** — one round-trip per file, aggregated into a single workspace graph.
- **Class as node** — methods are inlined as UML compartments; per-method `readState` tracks progress (see [ADR-002](docs/adrs/002-class-as-node-uml.md)).
- **Chat-first** — `@codemap` is the only entry point; no command palette command (see [ADR-003](docs/adrs/003-chat-as-orchestrator.md)).
- **LSP-calibrated** — every call edge is checked; mismatches surface as `droppedCalls` in `/why` (see [ADR-004](docs/adrs/004-calibration-layer.md)).
- **Dual eval** — node P/R *and* edge P/R, scored against hand-authored golden samples (`eval/`).
- **No API key** — uses `vscode.lm.LanguageModelChat` (Copilot).

## Quickstart (developing the extension)

```powershell
git clone https://github.com/<you>/codemap.git
cd codemap
npm install
npm run build           # produces dist/extension.js + dist/webview.js
```

Then open the folder in VS Code and press **F5** to launch the Extension Development Host. In the new window:

1. Open a workspace you want to map (the [lumen-backend](docs/mockups/lumen-backend-v3.html) mockup is what the v3 plan was tuned against).
2. Open the GitHub Copilot Chat view.
3. Type `@codemap` and pick a sub-command.

### Run tests

```powershell
npm test                # vitest run (118 tests, ~2s)
npm run test:watch      # vitest watch mode
npm run lint            # tsc --noEmit
```

### Run the eval harness

```powershell
# score a graph dump against a golden sample
npm run eval -- eval/samples/lumen-mini/actual-perfect.json eval/samples/lumen-mini/golden.json
```

See [`eval/README.md`](eval/README.md) for the schema and the in-chat auto-eval trigger (`.codemap/golden.json`).

### Package a .vsix

```powershell
npm run package         # vsce package -> codemap-0.0.1.vsix
```

## Repo layout

```
codemap/
├── docs/
│   ├── mockups/                          # canonical UI references (v3.html)
│   ├── plan/                             # development plans (v3 is the active one)
│   └── adrs/                             # 4 core architectural decision records
├── src/
│   ├── chat/                             # @codemap chat participant + responders
│   ├── graph/                            # workspace scanner, single-file analyzer, aggregator
│   ├── calibration/                      # LLM ↔ LSP cross-check
│   ├── persistence/                      # workspaceState graph store + reading progress
│   ├── webview/                          # Cytoscape-based UML renderer
│   ├── llm/                              # vscode.lm wrappers
│   ├── orchestrator/                     # turn-level orchestration helpers
│   ├── eval/                             # scoring functions used both in-chat and via CLI
│   ├── editor/                           # editor / decoration glue
│   └── extension.ts                      # activation
├── eval/                                 # CLI eval harness + golden samples
└── test/unit/                            # vitest suites (calibrator, graph-store, responders, …)
```

## Architecture decisions

The four ADRs explain the major shape choices:

| # | Decision | Key trade-off |
|---|----------|---------------|
| [001](docs/adrs/001-repo-level-mvp.md) | Repo-level MVP, not method-level | One LLM pass per file, but `/why` on a method requires reading `methods[]` instead of walking edges |
| [002](docs/adrs/002-class-as-node-uml.md) | Class as the node, methods inlined as UML compartments | Wide graphs, but reading order is meaningful and per-method `readState` is natural |
| [003](docs/adrs/003-chat-as-orchestrator.md) | Chat participant is the only entry point | Hard dep on `GitHub.copilot-chat`, but one mental model and free turn memory |
| [004](docs/adrs/004-calibration-layer.md) | Separate calibration layer (LLM ↔ LSP) | One extra pass over the graph, but every `/why` answer is grounded in LSP data, not in a confidence score |

## Tech stack

- VS Code Extension API ≥ 1.90, Chat Participant API
- `vscode.lm` (GitHub Copilot models)
- LSP commands (`executeDocumentSymbolProvider`, `executeWorkspaceSymbolProvider`, `executeDefinitionProvider`)
- Cytoscape.js + dagre layout, `cy-node-html-label` for the UML compartments
- TypeScript, esbuild (`extension.js` for node, `webview.js` for browser)
- Vitest for unit tests

## Status & roadmap

| Phase | Scope | State |
|-------|-------|-------|
| W1 | Extension scaffold, chat participant, WebView fed by fixtures | ✅ |
| W2 | Workspace scanner, single-file analyzer, calibrator | ✅ |
| W3 | Aggregator, cross-file edges, end-to-end on lumen | ✅ |
| W4 | Eval harness, prompt tuning, `/scope`, `/focus`, `/why`, `/explain` | ✅ |
| W5 | ADRs, README, LICENSE, minimap, `.vsix` | 🚧 (ADRs + README + LICENSE done; minimap & marketplace listing pending) |

## License

[MIT](LICENSE).
