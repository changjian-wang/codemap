// Phase 2.5 -- subprocess lifecycle acceptance test.
//
// Covers:
//   - start() spawns and reaches `ready` state after `initialize`.
//   - ping() works on a fresh host.
//   - SIGKILL on the child triggers auto-respawn with backoff, and the
//     next ping() succeeds against the new pid (different from the old).
//   - dispose() tears down cleanly and prevents further requests.
//
// HITL counterpart: manually `kill -9 <pid>` while the extension is
// running and observe the same respawn flow against a real workspace.

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  CSharpCalibratorHost,
  CalibratorHostError,
  type HostLifecycleEvent,
} from '../../src/calibration/host/csharp-host';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CALIBRATOR_EXE = resolve(
  __dirname,
  '../../tools/codemap-calibrator-csharp/bin/Debug/net8.0/codemap-calibrator-csharp',
);

const describeIfBuilt = existsSync(CALIBRATOR_EXE) ? describe : describe.skip;

function waitForEvent(
  events: HostLifecycleEvent[],
  match: (e: HostLifecycleEvent) => boolean,
  timeoutMs = 10_000,
): Promise<HostLifecycleEvent> {
  return new Promise((res, rej) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const hit = events.find(match);
      if (hit) {
        clearInterval(iv);
        res(hit);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        rej(new Error(`waitForEvent timeout after ${timeoutMs}ms`));
      }
    }, 25);
  });
}

describeIfBuilt('CSharpCalibratorHost lifecycle', () => {
  it('spawns, ping works, dispose tears down cleanly', async () => {
    const events: HostLifecycleEvent[] = [];
    const host = new CSharpCalibratorHost({
      executable: CALIBRATOR_EXE,
      clientName: 'lifecycle-test',
      onEvent: (e) => events.push(e),
    });
    try {
      await host.start();
      expect(host.isReady).toBe(true);
      expect(host.pid).toBeGreaterThan(0);

      const pong = await host.ping({ token: 'hello' });
      expect(pong.echo).toBe('hello');
      expect(pong.initialized).toBe(true);

      const initEvt = events.find((e) => e.type === 'initialized');
      expect(initEvt).toBeDefined();
    } finally {
      await host.dispose();
    }
    expect(events.some((e) => e.type === 'disposed')).toBe(true);
  });

  it('auto-respawns after SIGKILL and next ping succeeds against a fresh pid', async () => {
    const events: HostLifecycleEvent[] = [];
    const host = new CSharpCalibratorHost({
      executable: CALIBRATOR_EXE,
      clientName: 'respawn-test',
      onEvent: (e) => events.push(e),
    });
    try {
      await host.start();
      const originalPid = host.pid;
      expect(originalPid).toBeGreaterThan(0);

      // Hard-kill the child. This simulates `kill -9 <pid>` from a shell.
      process.kill(originalPid!, 'SIGKILL');

      // The host should observe the exit, schedule a respawn, spawn
      // again, and re-initialize. We block on the second `initialized`
      // event to know readiness is restored.
      const respawnScheduled = await waitForEvent(
        events,
        (e) => e.type === 'respawn-scheduled',
      );
      expect(respawnScheduled.type).toBe('respawn-scheduled');

      // Give the host time to come back up. ping() will auto-await start
      // internally because state transitions through `restarting` ->
      // `spawning` -> `ready`.
      // We can't just call ping() immediately because state during the
      // backoff window is `restarting`, and request() only auto-starts
      // from `idle`. Poll until ready.
      const readyDeadline = Date.now() + 15_000;
      while (!host.isReady && Date.now() < readyDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(host.isReady).toBe(true);
      expect(host.pid).toBeGreaterThan(0);
      expect(host.pid).not.toBe(originalPid);

      const pong = await host.ping({ token: 'after-kill' });
      expect(pong.echo).toBe('after-kill');
      expect(pong.initialized).toBe(true);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it('rejects further requests after dispose', async () => {
    const host = new CSharpCalibratorHost({
      executable: CALIBRATOR_EXE,
      clientName: 'dispose-test',
    });
    await host.start();
    await host.dispose();
    await expect(host.ping()).rejects.toBeInstanceOf(CalibratorHostError);
  });
});
