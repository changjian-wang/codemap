# Contributing to CodeMap

Thanks for your interest! This guide covers everything you need to hack on CodeMap locally.

> Looking for the user-facing docs instead? See [README.md](README.md).

## Develop locally

```powershell
git clone https://github.com/changjian-wang/codemap.git
cd codemap
npm install
npm run build           # produces dist/extension.js
```

Open the folder in VS Code and press **F5** to launch the Extension Development Host. In the new window:

1. Open a workspace you want to map.
2. Open the GitHub Copilot Chat view.
3. Type `@codemap` and pick a sub-command.

## Run tests

```powershell
npm test                # vitest run (247 tests, ~1.5s)
npm run test:watch      # vitest watch mode
npm run lint            # tsc --noEmit
```

## Run the eval harness

```powershell
# score a graph dump against a golden sample
npm run eval -- eval/samples/lumen-mini/actual-perfect.json eval/samples/lumen-mini/golden.json
```

See [`eval/README.md`](eval/README.md) for the schema and the in-chat auto-eval trigger (`.codemap/golden.json`).

## Package a .vsix

```powershell
npx @vscode/vsce package
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
| [004](docs/adrs/004-calibration-layer.md) | Separate calibration layer (LLM ↔ LSP) | One extra pass over the graph, but every `/why` answer is grounded in LSP data, not a confidence score |

Product shape is locked by the [view mockup](docs/mockups/codemap-view.html) and the [v3 development plan](docs/plan/development-plan-v3-repo-level.md).

## Tech stack

- VS Code Extension API ≥ 1.90, Chat Participant API
- `vscode.lm` (GitHub Copilot models)
- LSP commands (`executeDocumentSymbolProvider`, `executeWorkspaceSymbolProvider`, `executeDefinitionProvider`)
- Cytoscape.js + dagre layout, `cy-node-html-label` for the UML compartments
- TypeScript, esbuild
- Vitest for unit tests

## Pull requests

- Run `npm test` and `npm run build` before pushing.
- Keep `npm run lint` (`tsc --noEmit`) clean — the build step does **not** type-check.
- For UI changes, update the mockup in `docs/mockups/codemap-view.html` so the spec stays in sync with the implementation.
- New verification logic should land with a calibrator test under `test/unit/`.
