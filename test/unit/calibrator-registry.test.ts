// Phase 2.8 -- CalibratorRegistry unit test.
//
// Verifies the language-id -> calibrator-class routing table without
// spawning the .NET subprocess or loading a ts-morph project. We
// instantiate the registry with a dummy executable path so that the
// `csharp` route returns CSharpCalibratorHost; we then assert the
// concrete class identity for each documented language id.

import { describe, expect, it } from 'vitest';
import { CSharpCalibratorHost } from '../../src/calibration/host/csharp-host';
import { NullCalibrator } from '../../src/calibration/null-calibrator';
import {
  CalibratorRegistry,
  calibratorKindForLanguage,
} from '../../src/calibration/registry';
import { TypeScriptCalibrator } from '../../src/calibration/typescript-calibrator';

describe('CalibratorRegistry -- language routing', () => {
  it('routes csharp -> CSharpCalibratorHost when executable is configured', () => {
    const registry = new CalibratorRegistry({ csharpExecutable: '/tmp/fake-exec' });
    const got = registry.getCalibrator('csharp');
    expect(got).toBeInstanceOf(CSharpCalibratorHost);
  });

  it('routes csharp -> NullCalibrator when no executable is configured', () => {
    const registry = new CalibratorRegistry();
    const got = registry.getCalibrator('csharp');
    expect(got).toBeInstanceOf(NullCalibrator);
  });

  it.each([
    ['typescript'],
    ['javascript'],
    ['typescriptreact'],
    ['javascriptreact'],
  ])('routes %s -> TypeScriptCalibrator', (languageId) => {
    const registry = new CalibratorRegistry();
    const got = registry.getCalibrator(languageId);
    expect(got).toBeInstanceOf(TypeScriptCalibrator);
  });

  it.each([
    ['python'],
    ['go'],
    ['rust'],
    ['unknown'],
    [''],
  ])('routes unsupported language %s -> NullCalibrator', (languageId) => {
    const registry = new CalibratorRegistry({ csharpExecutable: '/tmp/fake-exec' });
    const got = registry.getCalibrator(languageId);
    expect(got).toBeInstanceOf(NullCalibrator);
  });

  it('returns the same instance on repeated lookups (singleton per kind)', () => {
    const registry = new CalibratorRegistry({ csharpExecutable: '/tmp/fake-exec' });
    expect(registry.getCalibrator('typescript')).toBe(registry.getCalibrator('typescript'));
    expect(registry.getCalibrator('typescript')).toBe(registry.getCalibrator('javascript'));
    expect(registry.getCalibrator('csharp')).toBe(registry.getCalibrator('csharp'));
    expect(registry.getCalibrator('python')).toBe(registry.getCalibrator('rust'));
  });

  it('NullCalibrator produces empty callees and stub load result', async () => {
    const registry = new CalibratorRegistry();
    const cal = registry.getCalibrator('python');
    const load = await cal.loadSolution({ slnxPath: '/some/path' });
    expect(load.slnxPath).toBe('/some/path');
    expect(load.declaredProjectCount).toBe(0);
    expect(load.projects).toEqual([]);
    expect(load.diagnostics.some((d) => d.toLowerCase().includes('unverified'))).toBe(true);

    const callees = await cal.resolveCallees({
      filePath: '/x.py',
      line: 1,
      classId: 'Foo',
      methodName: 'bar',
    });
    expect(callees.callees).toEqual([]);
    expect(callees.methodFullyQualifiedName).toBe('Foo.bar');
  });

  it('dispose() releases every cached calibrator and is idempotent', async () => {
    const registry = new CalibratorRegistry();
    registry.getCalibrator('typescript');
    registry.getCalibrator('python');
    await registry.dispose();
    await registry.dispose(); // second call must not throw

    // After dispose, the next lookup creates a fresh instance.
    const ts1 = registry.getCalibrator('typescript');
    const ts2 = registry.getCalibrator('typescript');
    expect(ts1).toBe(ts2);
  });
});

describe('calibratorKindForLanguage', () => {
  it('returns csharp only when executable is configured', () => {
    expect(calibratorKindForLanguage('csharp', { csharpExecutable: '/x' })).toBe('csharp');
    expect(calibratorKindForLanguage('csharp')).toBe('null');
  });

  it('returns typescript for the four JS/TS variants', () => {
    expect(calibratorKindForLanguage('typescript')).toBe('typescript');
    expect(calibratorKindForLanguage('javascript')).toBe('typescript');
    expect(calibratorKindForLanguage('typescriptreact')).toBe('typescript');
    expect(calibratorKindForLanguage('javascriptreact')).toBe('typescript');
  });

  it('returns null for everything else', () => {
    expect(calibratorKindForLanguage('python')).toBe('null');
    expect(calibratorKindForLanguage('')).toBe('null');
  });
});
