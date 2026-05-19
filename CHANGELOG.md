# Changelog

All notable changes to this extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.1 — 2026-05-19

First public release.

### Added
- `@codemap` chat participant in GitHub Copilot Chat.
- Workspace scanner + single-file analyzer that produce a class-level UML graph.
- LSP calibration pass against `executeDocumentSymbolProvider` / `executeWorkspaceSymbolProvider`; nodes badged `✓ verified`, `⚠ partial`, or `✗ unverified`.
- Reading Order panel using DFS from entry classes, with risk-first / confidence-aware traversal.
- Interactive Cytoscape graph with dagre layout, UML class compartments, and a colored minimap.
- Details panel with expandable methods, jump-to-source links, risk pills, and `/why` explanations.
- Slash commands: `/scope`, `/focus`, `/why`, `/explain`.
- Reading progress (mark read / mark unread) persisted in `workspaceState`.
- Eval harness with node + edge precision/recall scoring (`eval/`).
