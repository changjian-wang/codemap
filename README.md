# CodeMap

> Interactive UML-style call graph + reading guidance for AI-generated code, packaged as a VS Code chat participant.

**Status:** v0.0.3 — render-blanking fix + prompt v3.4 (drops framework plumbing from `external_calls`).

![CodeMap UI](https://raw.githubusercontent.com/changjian-wang/codemap/main/docs/media/screenshot.png)

---

## Install

1. Make sure **GitHub Copilot Chat** is installed and signed in (CodeMap depends on `vscode.lm`).
2. Install CodeMap:
   - **From a `.vsix`**: download from [Releases](https://github.com/changjian-wang/codemap/releases) and run
     ```powershell
     code --install-extension codemap-<version>.vsix
     ```
   - **From the Marketplace** (once published): search for "CodeMap" in the Extensions view.
3. Open any workspace and the Copilot Chat view, then type `@codemap`.

No API key, no separate service — CodeMap uses the same Copilot model selector you already see in chat.

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

### Reading order

The left-side **Reading Order** panel is not just an alphabetical list — it's a recommended traversal of the codebase. The default rule for a first read is **top-to-bottom**:

1. **Entry classes first.** Anything with no inbound `calls` edge (route handlers, workers, `Program.cs`-style bootstrappers) leads.
2. **Production before tests.** Test classes (`/test/`, `*Tests.cs`, `*.spec.ts`, ...) are demoted to the tail of their group.
3. **DFS from each entry**, visiting **higher-risk and lower-confidence children first** so the scary code surfaces while you're paying attention.
4. **Orphans / cycle-only nodes last**, ordered by the LLM's `readingPriority` hint.

Useful workflows:

- **Onboarding a new repo** — read 1 → N. The order mirrors the main control flow.
- **Code review** — scan the top of the list for red risk dots and `partial` / `unverified` badges.
- **Resume later** — click **✓ Mark read** in the details panel; read items get struck through in the outline.
- **Narrow the scope** — `@codemap /scope src/Capture` re-runs the analysis on a subpath and renumbers.
- **Drill into one class** — `@codemap /focus IngestUrlHandler` shows just its ±1-hop neighborhood.

### Details panel

Clicking a node (in the graph or the outline) centers it on the canvas and opens the right-side Details panel:

- **Verification badge** — `✓ verified` (LSP matched everything), `⚠ partial` (some calls / external symbols not resolvable), `✗ unverified` (LLM-only, jump disabled).
- **Methods (N)** — expand a row with `+` to see intent, doc comment, params, calls, and risks. Click ⤴ to jump to the exact line in source.
- **Risks** — colored pills with the calibrator's reason (e.g. `security`, `concurrency`, `external_io`).
- **Actions** — `↪ Jump to file`, `✓ Mark read`, `💬 Ask @codemap`.
- **`/why <Class>`** — explains exactly which `executeWorkspaceSymbolProvider` lookup failed and why the node ended up partial.


## Key properties

- **Repo-level** — one round-trip per file, aggregated into a single workspace graph.
- **Class as node** — methods are inlined as UML compartments; per-method `readState` tracks progress.
- **Chat-first** — `@codemap` is the only entry point; no command palette command.
- **LSP-calibrated** — every call edge is checked against the language server; mismatches surface in `/why`.
- **No API key** — uses `vscode.lm.LanguageModelChat` (Copilot).

## Develop locally

Want to hack on CodeMap, run the eval harness, or read the architecture decision records? See [CONTRIBUTING.md](https://github.com/changjian-wang/codemap/blob/main/CONTRIBUTING.md).

## Status

v0.0.1 — first public release. All planned scope for the initial milestone (workspace scanner, single-file analyzer, calibrator, aggregator, eval harness, `/scope`, `/focus`, `/why`, `/explain`, minimap, `.vsix` packaging) is in. Marketplace listing and a demo GIF are next.

## License

[MIT](LICENSE).
