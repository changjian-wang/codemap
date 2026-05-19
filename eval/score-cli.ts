#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * CLI wrapper around `scoreGraph`. Reads a CodeMapGraph JSON ("actual") and a
 * GoldenSample JSON ("golden") and prints precision / recall / F1 plus the
 * concrete diff. Mainly for local iteration on prompts: dump a real graph
 * from the WebView ("Export → JSON") and run it against a hand-authored
 * golden to detect regressions.
 *
 * Usage:
 *   npm run eval -- --actual path/to/graph.json --golden path/to/golden.json
 *   npm run eval -- --actual path/to/graph.json --golden path/to/golden.json --json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scoreGraph, type GoldenSample } from '../src/eval/score';
import type { CodeMapGraph } from '../src/shared/types';

interface CliArgs {
  actual: string;
  golden: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = { json: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--actual' || a === '-a') out.actual = argv[++i];
    else if (a === '--golden' || a === '-g') out.golden = argv[++i];
    else if (a === '--json' || a === '-j') out.json = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: npm run eval -- <actual.json> <golden.json> [--json]\n' +
          '   or: npm run eval -- --actual <actual.json> --golden <golden.json> [--json]',
      );
      process.exit(0);
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }
  // Positional fallback: <actual> <golden>. Lets users invoke the script
  // without struggling with PowerShell swallowing `--actual`.
  if (!out.actual && positional[0]) out.actual = positional[0];
  if (!out.golden && positional[1]) out.golden = positional[1];

  if (!out.actual || !out.golden) {
    console.error(
      'Both --actual and --golden (or positional <actual> <golden>) are required. Run with --help for usage.',
    );
    process.exit(1);
  }
  return out as CliArgs;
}

function readJson<T>(file: string): T {
  const abs = path.resolve(file);
  const raw = fs.readFileSync(abs, 'utf-8');
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    console.error(`Failed to parse JSON: ${abs}`);
    throw e;
  }
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const actual = readJson<CodeMapGraph>(args.actual);
  const golden = readJson<GoldenSample>(args.golden);
  const sc = scoreGraph(actual, golden);

  if (args.json) {
    process.stdout.write(JSON.stringify(sc, null, 2) + '\n');
    return;
  }

  console.log(`Golden: ${golden.name}${golden.description ? ` — ${golden.description}` : ''}`);
  console.log(
    `Scope:  ${(golden.scopeFiles && golden.scopeFiles.length > 0 ? golden.scopeFiles.join(', ') : '(whole graph)')}`,
  );
  console.log('');
  console.log(
    `Nodes:  P=${fmt(sc.nodes.precision)} R=${fmt(sc.nodes.recall)} F1=${fmt(sc.nodes.f1)}`,
  );
  console.log(
    `Edges:  P=${fmt(sc.edges.precision)} R=${fmt(sc.edges.recall)} F1=${fmt(sc.edges.f1)}`,
  );
  console.log('');

  if (sc.diff.missingNodes.length > 0) {
    console.log(`Missing nodes (${sc.diff.missingNodes.length}):`);
    for (const n of sc.diff.missingNodes) console.log(`  - ${n}`);
  }
  if (sc.diff.extraNodes.length > 0) {
    console.log(`Extra nodes (${sc.diff.extraNodes.length}):`);
    for (const n of sc.diff.extraNodes) console.log(`  + ${n}`);
  }
  if (sc.diff.missingEdges.length > 0) {
    console.log(`Missing edges (${sc.diff.missingEdges.length}):`);
    for (const e of sc.diff.missingEdges) console.log(`  - ${e.from} → ${e.to}`);
  }
  if (sc.diff.extraEdges.length > 0) {
    console.log(`Extra edges (${sc.diff.extraEdges.length}):`);
    for (const e of sc.diff.extraEdges) console.log(`  + ${e.from} → ${e.to}`);
  }

  // Exit non-zero when nothing matched; useful in CI as a smoke check.
  if (sc.nodes.f1 === 0 && sc.edges.f1 === 0) process.exit(2);
}

main();
