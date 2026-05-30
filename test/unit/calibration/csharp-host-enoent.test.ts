// Regression: dispose() must return quickly when start() failed with a
// spawn error (ENOENT). Previously the host left a stale `proc` reference
// whose 'exit' event had already fired, and `dispose()` would await a
// future 'exit' that never came -- hanging the chat turn after the
// orchestrator's finally{} block.

import { describe, it, expect } from 'vitest';
import { CSharpCalibratorHost } from '../../../src/calibration/host/csharp-host';

describe('CSharpCalibratorHost dispose after spawn failure', () => {
  it('returns within 1s when the executable does not exist', async () => {
    const host = new CSharpCalibratorHost({
      executable: '/definitely/not/a/real/path/codemap-calibrator-csharp-missing',
      workspaceRoot: '/tmp',
      clientName: 'enoent-test',
    });

    await expect(host.start()).rejects.toThrow();

    const t0 = Date.now();
    await host.dispose();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);
  });

  it('is safe to call dispose() before start() has been awaited', async () => {
    const host = new CSharpCalibratorHost({
      executable: '/definitely/not/a/real/path/codemap-calibrator-csharp-missing',
      workspaceRoot: '/tmp',
      clientName: 'enoent-test-parallel',
    });

    const startP = host.start();
    // Attach a no-op catch immediately so readyPromise's rejection during
    // dispose() does not flash as an unhandled rejection before the
    // assertion below installs its handler.
    const startSettled = startP.then(
      () => ({ ok: true }),
      (err: Error) => ({ ok: false, err }),
    );

    const t0 = Date.now();
    await host.dispose();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);

    const result = await startSettled;
    expect(result.ok).toBe(false);
  });
});
