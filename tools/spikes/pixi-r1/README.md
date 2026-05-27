# R1 — Pixi.js performance spike

> Spike for ADR-005 §7.1. **Delete after conclusion lands in the ADR.**

## Question

Can Pixi.js v8 hit ≥ 30 fps at 100 nodes + 200 edges in a WebGL-capable browser? What's the bundle size?

(CSP compatibility with VS Code webview is **deferred to slice 1.1** — that's where the bundling decision lives.)

## Run

Open `index.html` directly in Chrome / Edge — `file://` + CDN ESM works, no local server needed.

If you prefer a clean origin:

```pwsh
npx serve tools/spikes/pixi-r1
```

## Read

- Top-left HUD: live fps + frametime + renderer type (WebGL / WebGPU).
- Top-right controls: switch node count (100 / 500 / 1000 / 2000) and edges-per-node (2 or 5). "animate" toggles per-frame node motion.

The HUD turns the fps amber when it drops below 30.

## Acceptance criteria

| Criterion | Target | Result (HITL) |
|---|---|---|
| 100 nodes × 2 edges, animated | ≥ 30 fps | _fill in_ |
| 500 nodes × 2 edges, animated | ≥ 30 fps | _fill in_ |
| 1000 nodes × 2 edges, animated | ≥ 30 fps (stretch) | _fill in_ |
| Renderer is WebGL | yes | _fill in_ |
| Pixi v8 bundle size (gzipped) | < 1 MB | _check `https://bundlephobia.com/package/pixi.js@8.6.0`_ |

## After conclusion

1. Fill the table above.
2. Append a one-paragraph summary to `docs/adrs/005-renderer-rewrite-pixi.md` §7.1.
3. Delete this whole `tools/spikes/pixi-r1/` directory (per the `prototype` skill — no orphan spikes in main).
