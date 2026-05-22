# Eval baselines

Frozen `actual` exports from real CodeMap runs, kept as regression fixtures so
scorer / prompt iterations can be compared against the same input.

## How to add or refresh a baseline

1. Install the relevant CodeMap VSIX in VS Code (`Install from VSIX...`).
2. Open the target workspace, run `@codemap generate codemap` (optionally
   `@codemap /scope <subdir>`).
3. From the webview toolbar: `Export → YAML`. Save here, naming
   `<workspace>-<version>-actual.yaml` (e.g. `lumen-v0.0.6-actual.yaml`).
4. Score with `npm run eval -- --actual <fixture> --golden <path-to-golden>`.
   The scorer reads YAML and JSON transparently (detection by file extension).

## Current fixtures

- `lumen-v0.0.6-actual.yaml` — `lumen/apps/api/src`, 116 classes / 323 edges,
  produced by `codemap-0.0.6.vsix`. v0.0.6 baseline numbers: Nodes F1=1.00,
  Edges F1=0.92 (P=0.87, R=0.97). Used as the slice-by-slice regression target
  for issue #1 (v0.0.7 precision pass).
