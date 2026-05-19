# Eval harness

Tiny precision/recall/F1 scorer for CodeMap graphs.

## How it works

1. Run `@codemap generate codemap` in any workspace and **export the graph as JSON** from the WebView (the "Export → JSON" button in the toolbar).
2. Hand-author a `golden.json` listing the classes and edges that *should* show up for that scope. See [`samples/lumen-mini/golden.json`](./samples/lumen-mini/golden.json) for the schema.
3. Score the actual graph against the golden:

   ```bash
   npm run eval -- --actual ./tmp/actual.json --golden ./eval/samples/lumen-mini/golden.json
   ```

   Add `--json` for machine-readable output.

The CLI exits with code `2` if both node and edge F1 are zero (handy as a smoke check in CI).

## Golden schema

```jsonc
{
  "name": "lumen-mini",
  "description": "Minimal Lumen backend slice covering ingest and ask",
  // Optional file-prefix filter — actual graph is filtered to only nodes
  // whose `file` starts with one of these before scoring. Leave empty to
  // score the whole graph.
  "scopeFiles": ["src/Lumen.Capture"],
  "nodes": ["IngestUrlHandler", "WebContentExtractor", "ChunkStore"],
  "edges": [
    { "from": "IngestUrlHandler", "to": "WebContentExtractor" },
    { "from": "IngestUrlHandler", "to": "ChunkStore" }
  ]
}
```

`scoreGraph` (in `src/eval/score.ts`) implements strict-overlap precision/recall on:
- node set (filtered by `scopeFiles`)
- edge set (only edges whose `from` is in the filtered node set)

## In-chat eval

When a workspace has a `.codemap/golden.json` (or `codemap.devGoldenPath` setting), the chat participant automatically scores every `@codemap generate codemap` run and surfaces P/R/F1 + the first 5 missing edges in the response stream.
