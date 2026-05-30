// Phase 2.7 acceptance -- parity test set.
//
// The "parity" claim is structural: both the in-process TypeScript
// calibrator and the out-of-process C# calibrator must produce
// ResolveCalleesResult payloads that conform to the SAME protocol
// validator (`parseResolveCalleesResult`) and use the SAME `kind`
// classification rules. Concrete callee sets differ per language and
// per fixture, so we don't compare names across languages.
//
// TypeScript side: load the new test/fixtures/typescript-parity sample
// and exercise every callable form the resolver gained in 2.7 (class
// method body, arrow-function class property, top-level const-assigned
// arrow). Asserts callee shapes and `kind` classifications.
//
// C# side: when both the calibrator binary and lumen.slnx are present,
// spawn the host, load the solution, resolve callees of a known method,
// and assert the response passes the same parser + each callee passes
// the same shape check. Skipped otherwise so fresh clones still pass.

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';

import { TypeScriptCalibrator } from '../../src/calibration/typescript-calibrator';
import { CSharpCalibratorHost } from '../../src/calibration/host/csharp-host';
import {
  parseResolveCalleesResult,
  type Callee,
  type ResolveCalleesResult,
} from '../../src/shared/calibrator-protocol';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const TS_FIXTURE_TSCONFIG = resolve(REPO_ROOT, 'test/fixtures/typescript-parity/tsconfig.json');
const TS_FIXTURE_SAMPLE = resolve(REPO_ROOT, 'test/fixtures/typescript-parity/sample.ts');

const CALIBRATOR_EXE = resolve(
  REPO_ROOT,
  'tools/codemap-calibrator-csharp/bin/Debug/net8.0/codemap-calibrator-csharp',
);
const LUMEN_SLNX = '/Users/aluneth/MyApps/github/lumen/apps/api/lumen.slnx';
const LUMEN_FILE =
  '/Users/aluneth/MyApps/github/lumen/apps/api/src/Lumen.Modules.Recall/Features/RecallByQuery/RecallByQueryHandler.cs';

const EXPECTED_CALLEE_KEYS = [
  'displayName',
  'fullyQualifiedName',
  'containingType',
  'methodName',
  'kind',
  'isExternal',
  'isExtension',
  'filePath',
  'line',
  'invocationLine',
] as const;
const VALID_KINDS = new Set(['method', 'constructor', 'extension', 'localFunction', 'unknown']);

function assertCalleeShape(c: Callee, ctx: string): void {
  for (const k of EXPECTED_CALLEE_KEYS) {
    expect(c, `${ctx}: missing key ${k}`).toHaveProperty(k);
  }
  expect(VALID_KINDS.has(c.kind), `${ctx}: invalid kind ${c.kind}`).toBe(true);
  expect(typeof c.displayName).toBe('string');
  expect(typeof c.fullyQualifiedName).toBe('string');
  expect(typeof c.containingType).toBe('string');
  expect(typeof c.methodName).toBe('string');
  expect(typeof c.isExternal).toBe('boolean');
  expect(typeof c.isExtension).toBe('boolean');
  expect(typeof c.invocationLine).toBe('number');
  expect(c.invocationLine).toBeGreaterThan(0);
  if (c.filePath !== null) expect(typeof c.filePath).toBe('string');
  if (c.line !== null) {
    expect(typeof c.line).toBe('number');
    expect(c.line).toBeGreaterThan(0);
  }
}

describe('parity -- TypeScript resolver covers all callable forms', () => {
  let ts: TypeScriptCalibrator | null = null;

  afterEach(async () => {
    if (ts) {
      await ts.dispose();
      ts = null;
    }
  });

  it('class method body resolves intra-class + cross-class + new', async () => {
    ts = new TypeScriptCalibrator();
    await ts.loadSolution({ slnxPath: TS_FIXTURE_TSCONFIG });
    const raw = await ts.resolveCallees({
      filePath: TS_FIXTURE_SAMPLE,
      line: 7, // Calculator.run
      classId: 'Calculator',
      methodName: 'run',
    });
    const result: ResolveCalleesResult = parseResolveCalleesResult(raw);
    expect(result.callees.length).toBeGreaterThan(0);
    result.callees.forEach((c, i) => assertCalleeShape(c, `Calculator.run[${i}]`));

    const byName = new Map<string, Callee>();
    for (const c of result.callees) byName.set(c.methodName, c);

    // intra-class call
    expect(byName.get('add')?.kind).toBe('method');
    expect(byName.get('add')?.containingType).toBe('Calculator');
    expect(byName.get('add')?.isExternal).toBe(false);

    // cross-class static call
    expect(byName.get('double')?.kind).toBe('method');
    expect(byName.get('double')?.containingType).toBe('Helper');
    expect(byName.get('double')?.isExternal).toBe(false);

    // constructor via `new` (NewExpression branch)
    const ctor = result.callees.find((c) => c.kind === 'constructor');
    expect(ctor, 'expected a constructor callee for new Wrapper(...)').toBeDefined();
    expect(ctor!.displayName.startsWith('new ')).toBe(true);
  });

  it('arrow-function class property has a walkable body', async () => {
    ts = new TypeScriptCalibrator();
    await ts.loadSolution({ slnxPath: TS_FIXTURE_TSCONFIG });
    const raw = await ts.resolveCallees({
      filePath: TS_FIXTURE_SAMPLE,
      line: 19, // Calculator.reset arrow property
      classId: 'Calculator',
      methodName: 'reset',
    });
    const result = parseResolveCalleesResult(raw);
    result.callees.forEach((c, i) => assertCalleeShape(c, `Calculator.reset[${i}]`));
    expect(result.methodName).toBe('reset');

    const names = result.callees.map((c) => c.methodName);
    expect(names).toContain('double');
    const doubleCall = result.callees.find((c) => c.methodName === 'double');
    expect(doubleCall?.containingType).toBe('Helper');
    expect(doubleCall?.kind).toBe('method');
  });

  it('top-level const-assigned arrow resolves with empty classId', async () => {
    ts = new TypeScriptCalibrator();
    await ts.loadSolution({ slnxPath: TS_FIXTURE_TSCONFIG });
    const raw = await ts.resolveCallees({
      filePath: TS_FIXTURE_SAMPLE,
      line: 38, // export const topLevelArrow = ...
      classId: '',
      methodName: 'topLevelArrow',
    });
    const result = parseResolveCalleesResult(raw);
    result.callees.forEach((c, i) => assertCalleeShape(c, `topLevelArrow[${i}]`));

    const names = result.callees.map((c) => c.methodName);
    expect(names).toContain('topLevelHelper');
    const helperCall = result.callees.find((c) => c.methodName === 'topLevelHelper');
    expect(helperCall?.containingType).toBe('');
    expect(helperCall?.kind).toBe('method');
  });

  it('Driver.drive classifies every form consistently', async () => {
    ts = new TypeScriptCalibrator();
    await ts.loadSolution({ slnxPath: TS_FIXTURE_TSCONFIG });
    const raw = await ts.resolveCallees({
      filePath: TS_FIXTURE_SAMPLE,
      line: 43, // Driver.drive
      classId: 'Driver',
      methodName: 'drive',
    });
    const result = parseResolveCalleesResult(raw);
    result.callees.forEach((c, i) => assertCalleeShape(c, `Driver.drive[${i}]`));

    const byName = new Map<string, Callee>();
    for (const c of result.callees) byName.set(c.methodName, c);

    // class method on a local
    expect(byName.get('run')?.kind).toBe('method');
    expect(byName.get('run')?.containingType).toBe('Calculator');

    // arrow-property class member
    expect(byName.get('reset')?.kind).toBe('method');
    expect(byName.get('reset')?.containingType).toBe('Calculator');

    // top-level function
    expect(byName.get('topLevelHelper')?.kind).toBe('method');
    expect(byName.get('topLevelHelper')?.containingType).toBe('');

    // top-level const arrow
    expect(byName.get('topLevelArrow')?.kind).toBe('method');
    expect(byName.get('topLevelArrow')?.containingType).toBe('');

    // `new Calculator()` -> constructor branch
    const ctor = result.callees.find((c) => c.kind === 'constructor');
    expect(ctor).toBeDefined();
  });
});

const describeIfCSharp =
  existsSync(CALIBRATOR_EXE) && existsSync(LUMEN_SLNX) && existsSync(LUMEN_FILE)
    ? describe
    : describe.skip;

describeIfCSharp('parity -- C# resolveCallees conforms to the same shape contract', () => {
  let host: CSharpCalibratorHost | null = null;

  afterEach(async () => {
    if (host) {
      await host.dispose();
      host = null;
    }
  });

  it('lumen.slnx + RecallByQueryHandler.HandleAsync produces protocol-valid callees', async () => {
    host = new CSharpCalibratorHost({
      executable: CALIBRATOR_EXE,
      clientName: 'parity-test',
    });
    await host.start();
    const loaded = await host.loadSolution({ slnxPath: LUMEN_SLNX });
    expect(loaded.loadedProjectCount).toBeGreaterThan(0);

    const result = await host.resolveCallees({
      filePath: LUMEN_FILE,
      line: 15,
      classId: 'RecallByQueryHandler',
      methodName: 'HandleAsync',
    });

    // host.resolveCallees parses internally; reaching this line means
    // parseResolveCalleesResult already accepted the C# wire payload.
    // Apply the per-callee shape contract explicitly so any drift in
    // kind/isExternal/isExtension surfaces here.
    expect(result.callees.length).toBeGreaterThan(0);
    result.callees.forEach((c, i) => assertCalleeShape(c, `C#[${i}]`));
  }, 240_000);
});
