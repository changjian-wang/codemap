#!/usr/bin/env node
/* eslint-disable no-console */

// Phase 3.4 -- v2 score CLI.
//
// Reads a v2 CodeMapGraph ("actual", produced by `@codemap` "Export -> JSON"
// or by hand-editing a fixture) and a GoldenSample ("golden") and prints
// precision / recall / F1 plus the concrete diff. Accepts both JSON and
// YAML for both inputs (detected by extension; .json -> JSON.parse,
// anything else -> YAML.parse which also handles JSON).
//
// Usage:
//   npm run eval -- --actual path/to/graph.json --golden path/to/golden.json
//   npm run eval -- path/to/graph.json path/to/golden.json
//   npm run eval -- ... --json
//
// Exits 2 when nothing matched (smoke check for CI).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as YAML from 'yaml';
import { scoreGraph, type GoldenSample, type EvalScore } from '../src/eval/score';
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
        'Usage: npm run eval -- <actual> <golden> [--json]\n' +
          '   or: npm run eval -- --actual <actual> --golden <golden> [--json]\n' +
          '\n' +
          'Both files may be .json or .yaml; YAML can also parse JSON.',
      );
      process.exit(0);
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }
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

function readDoc<T>(file: string): T {
  const abs = path.resolve(file);
  const raw = fs.readFileSync(abs, 'utf-8');
  const ext = path.extname(abs).toLowerCase();
  try {
    if (ext === '.json') return JSON.parse(raw) as T;
    return YAML.parse(raw) as T;
  } catch (e) {
    console.error(`Failed to parse ${ext === '.json' ? 'JSON' : 'YAML'}: ${abs}`);
    throw e;
  }
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function line(label: string, sc: EvalScore): void {
  console.log(`${label}  P=${fmt(sc.precision)} R=${fmt(sc.recall)} F1=${fmt(sc.f1)}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const actual = readDoc<CodeMapGraph>(args.actual);
  const golden = readDoc<GoldenSample>(args.golden);
  const sc = scoreGraph(actual, golden);

  if (args.json) {
    process.stdout.write(JSON.stringify(sc, null, 2) + '\n');
    return;
  }

  console.log(
    `Golden: ${golden.name}${golden.description ? ` -- ${golden.description}` : ''}`,
  );
  console.log(
    `Scope:  ${
      golden.scopeFiles && golden.scopeFiles.length > 0
        ? golden.scopeFiles.join(', ')
        : '(whole graph)'
    }`,
  );
  console.log('');
  line('Classes:     ', sc.classes);
  line('Class edges: ', sc.classEdges);
  if (sc.methods && sc.methodEdges) {
    line('Methods:     ', sc.methods);
    line('Method edges:', sc.methodEdges);
  }
  console.log('');

  const cd = sc.diff.classes;
  if (cd.missingNodes.length > 0) {
    console.log(`Missing class nodes (${cd.missingNodes.length}):`);
    for (const n of cd.missingNodes) console.log(`  - ${n}`);
  }
  if (cd.extraNodes.length > 0) {
    console.log(`Extra class nodes (${cd.extraNodes.length}):`);
    for (const n of cd.extraNodes) console.log(`  + ${n}`);
  }
  if (cd.missingEdges.length > 0) {
    console.log(`Missing class edges (${cd.missingEdges.length}):`);
    for (const e of cd.missingEdges) console.log(`  - ${e.from} -> ${e.to}`);
  }
  if (cd.extraEdges.length > 0) {
    console.log(`Extra class edges (${cd.extraEdges.length}):`);
    for (const e of cd.extraEdges) console.log(`  + ${e.from} -> ${e.to}`);
  }

  const md = sc.diff.methods;
  if (md) {
    if (md.missingNodes.length > 0) {
      console.log(`Missing method nodes (${md.missingNodes.length}):`);
      for (const n of md.missingNodes) console.log(`  - ${n}`);
    }
    if (md.extraNodes.length > 0) {
      console.log(`Extra method nodes (${md.extraNodes.length}):`);
      for (const n of md.extraNodes) console.log(`  + ${n}`);
    }
    if (md.missingEdges.length > 0) {
      console.log(`Missing method edges (${md.missingEdges.length}):`);
      for (const e of md.missingEdges) console.log(`  - ${e.from} -> ${e.to}`);
    }
    if (md.extraEdges.length > 0) {
      console.log(`Extra method edges (${md.extraEdges.length}):`);
      for (const e of md.extraEdges) console.log(`  + ${e.from} -> ${e.to}`);
    }
  }

  const cF1 = sc.classes.f1 + sc.classEdges.f1;
  const mF1 = (sc.methods?.f1 ?? 0) + (sc.methodEdges?.f1 ?? 0);
  if (cF1 === 0 && mF1 === 0) process.exit(2);
}

main();
