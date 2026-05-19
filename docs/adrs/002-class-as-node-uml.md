# ADR 002: Class as the node, methods inlined as UML compartments

**Status:** Accepted
**Date:** 2025-02

## Context

ADR-001 fixed the granularity at *class*. That left a separate question: how should each class be **rendered** in the WebView? The two ends of the design spectrum:

- A pure dot/circle with the class name (PlantUML-default). Compact, but the user has to click every node to see the methods.
- The full UML "class box" with attributes and operations. Verbose, but immediately readable.

Our target user is an engineer trying to *understand* AI-generated code, not catalog it. They need to be able to ask "where does this class actually do work?" without clicking everywhere.

## Decision

**Each node renders as a UML class compartment** with three regions:

1. **Header** — class name, bounded-context badge, verification badge (✓ / ⚠ / ✗).
2. **Method list** — `methods[]` as collapsible rows. Each row shows signature, risk pills, an `intent` one-liner, and a per-method read checkbox.
3. **Footer** — file path (clickable, jumps to source), confidence score, layer chip.

Cytoscape `cy-node-html-label` extension is used so the box can host real HTML, not just SVG text. This keeps interaction (checkboxes, "jump to source" link, focus button) on the node, not in a separate side panel.

## Consequences

**Positive**

- Reading order ("blue path") is meaningful: the user can see *what* each step is for, not just *which* class.
- Per-method `readState` lets us track progress at the granularity that maps to "I understood this method"; the class-level state is a derived rollup.
- `/why` and `/explain` can return per-method risk explanations using the same data shape.

**Negative**

- Wide screens needed. We accept this; CodeMap is positioned as a IDE-side-panel tool, not a phone widget.
- HTML labels mean the graph is heavier than a pure-SVG Cytoscape view. Performance budget: 200 nodes / 600 edges. Past that we will need a "summary view" toggle.

## Alternatives considered

1. **Side panel with class details on selection** — rejected, hides the architectural map. The whole point of CodeMap is "you can see the architecture at a glance".
2. **Pure SVG labels** — rejected, no inline interactivity, no per-method checkboxes.
3. **Mermaid `classDiagram`** — Mermaid does not give us click events / overlays / focus interactions of the kind W4 needs. Useful for static rendering in a CHANGELOG, not as our WebView.
