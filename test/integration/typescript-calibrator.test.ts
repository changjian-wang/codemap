// Phase 2.6 -- acceptance test: load the codemap repo via ts-morph and
// verify the TypeScript calibrator can resolve callees of `activate` in
// src/extension.ts, including `registerChatParticipant` from
// src/chat/participant.ts. This satisfies the v4-plan 2.6 acceptance
// criterion ("load codemap repo itself; resolve registerChatParticipant
// callees from src/extension.ts").

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';

import { TypeScriptCalibrator } from '../../src/calibration/typescript-calibrator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const TS_CONFIG = resolve(REPO_ROOT, 'tsconfig.json');
const EXTENSION_TS = resolve(REPO_ROOT, 'src/extension.ts');

describe('TypeScriptCalibrator -- codemap self-load', () => {
  let calibrator: TypeScriptCalibrator | null = null;

  afterEach(async () => {
    if (calibrator) {
      await calibrator.dispose();
      calibrator = null;
    }
  });

  it('loadSolution loads codemap tsconfig.json and reports source files', async () => {
    calibrator = new TypeScriptCalibrator();
    const result = await calibrator.loadSolution({ slnxPath: TS_CONFIG });
    expect(result.slnxPath).toBe(TS_CONFIG);
    expect(result.loadedProjectCount).toBe(1);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].language).toBe('TypeScript');
    expect(result.diagnostics.join('\n')).toMatch(/Loaded \d+ source files/);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('loadSolution also accepts a directory containing tsconfig.json', async () => {
    calibrator = new TypeScriptCalibrator();
    const result = await calibrator.loadSolution({ slnxPath: REPO_ROOT });
    expect(result.slnxPath).toBe(TS_CONFIG);
  });

  it('resolveCallees on activate() returns registerChatParticipant + openPanel', async () => {
    calibrator = new TypeScriptCalibrator();
    await calibrator.loadSolution({ slnxPath: TS_CONFIG });

    const result = await calibrator.resolveCallees({
      filePath: EXTENSION_TS,
      line: 12, // export function activate(context: vscode.ExtensionContext)
      classId: '', // top-level function, no owning class
      methodName: 'activate',
    });

    expect(result.methodName).toBe('activate');
    expect(result.callees.length).toBeGreaterThan(0);

    const calleeNames = result.callees.map((c) => c.methodName);
    expect(calleeNames).toContain('registerChatParticipant');
    expect(calleeNames).toContain('openPanel');

    // The matching callee should NOT be external (it's in our own src/).
    const rcp = result.callees.find((c) => c.methodName === 'registerChatParticipant');
    expect(rcp).toBeDefined();
    expect(rcp!.isExternal).toBe(false);
    expect(rcp!.filePath).toMatch(/src\/chat\/participant\.ts$/);
    expect(rcp!.line).toBeGreaterThan(0);
    expect(rcp!.kind).toBe('method');

    // The vscode.commands.registerCommand calls should be flagged as
    // external (they resolve into @types/vscode .d.ts).
    const registerCommandHit = result.callees.find(
      (c) => c.methodName === 'registerCommand',
    );
    expect(registerCommandHit).toBeDefined();
    expect(registerCommandHit!.isExternal).toBe(true);
    expect(registerCommandHit!.filePath).toBeNull();
  });

  it('resolveCallees before loadSolution throws', async () => {
    calibrator = new TypeScriptCalibrator();
    await expect(
      calibrator.resolveCallees({
        filePath: EXTENSION_TS,
        line: 12,
        classId: '',
        methodName: 'activate',
      }),
    ).rejects.toThrow(/loadSolution/);
  });
});
