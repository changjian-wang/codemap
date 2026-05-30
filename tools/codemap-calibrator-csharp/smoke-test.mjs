#!/usr/bin/env node
// Smoke test for codemap-calibrator-csharp (Phase 2.1 + 2.2 surface).
//
// Sends LSP-framed JSON-RPC over stdio to a freshly spawned calibrator
// process, exercises initialize -> ping -> loadSolution -> shutdown,
// and asserts the basic contract.
//
// Usage:
//   node smoke-test.mjs                              # uses bundled defaults
//   node smoke-test.mjs <calibrator-exe> <slnx>     # explicit paths

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CALIBRATOR_EXE =
  process.argv[2] ??
  resolve(__dirname, 'bin/Debug/net8.0/codemap-calibrator-csharp');
const SLNX_PATH =
  process.argv[3] ??
  resolve(__dirname, '../../../lumen/apps/api/lumen.slnx');

if (!existsSync(CALIBRATOR_EXE)) {
  console.error(`[smoke] calibrator executable not found: ${CALIBRATOR_EXE}`);
  process.exit(2);
}
if (!existsSync(SLNX_PATH)) {
  console.error(`[smoke] slnx not found: ${SLNX_PATH}`);
  process.exit(2);
}

console.error(`[smoke] exe : ${CALIBRATOR_EXE}`);
console.error(`[smoke] slnx: ${SLNX_PATH}`);

const proc = spawn(CALIBRATOR_EXE, [], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let nextId = 1;
const pending = new Map();

// LSP framing decoder: state machine over the stdout byte stream.
let buf = Buffer.alloc(0);
proc.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buf.subarray(0, headerEnd).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      console.error('[smoke] malformed header:', JSON.stringify(header));
      process.exit(3);
    }
    const len = parseInt(m[1], 10);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + len) return;
    const body = buf.subarray(bodyStart, bodyStart + len).toString('utf8');
    buf = buf.subarray(bodyStart + len);
    try {
      const msg = JSON.parse(body);
      const resolver = pending.get(msg.id);
      if (resolver) {
        pending.delete(msg.id);
        resolver(msg);
      } else {
        console.error('[smoke] unexpected message:', body);
      }
    } catch (err) {
      console.error('[smoke] json parse failed:', err, body);
      process.exit(4);
    }
  }
});

function send(method, params, timeoutMs = 30000) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const frame = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectP(new Error(`[smoke] timeout after ${timeoutMs}ms on ${method}`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) rejectP(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolveP(msg.result);
    });
    proc.stdin.write(frame);
  });
}

function fail(msg) {
  console.error('[smoke] FAIL:', msg);
  try { proc.kill(); } catch {}
  process.exit(1);
}

(async () => {
  try {
    const t0 = Date.now();
    const init = await send('initialize', {
      workspaceRoot: resolve(__dirname, '../..'),
      clientName: 'smoke-test',
    });
    console.error(`[smoke] initialize -> ${JSON.stringify(init)}`);
    if (init.serverName !== 'codemap-calibrator-csharp') fail('serverName mismatch');
    if (init.capabilities?.slnxLoading !== true) fail('expected slnxLoading=true');

    const ping = await send('ping', { token: 'hello' });
    console.error(`[smoke] ping -> ${JSON.stringify(ping)}`);
    if (ping.echo !== 'hello') fail('ping echo mismatch');
    if (ping.initialized !== true) fail('ping initialized=false');

    // Cold-start MSBuildLocator + per-project OpenProjectAsync against
    // ~18 projects can take up to ~60-90 s on a fresh machine (R2 spike).
    const load = await send('loadSolution', { slnxPath: SLNX_PATH }, 180000);
    console.error(`[smoke] loadSolution -> elapsedMs=${load.elapsedMs} declared=${load.declaredProjectCount} loaded=${load.loadedProjectCount} distinct=${load.distinctProjectCount}`);
    if (load.distinctProjectCount < 5) fail(`expected >=5 projects, got ${load.distinctProjectCount}`);
    const names = load.projects.map((p) => p.name);
    console.error(`[smoke] projects (${names.length}): ${names.join(', ')}`);
    const firstLumen = names.find((n) => n.startsWith('Lumen.'));
    if (!firstLumen) fail(`no Lumen.* project found; got: ${names.join(', ')}`);
    if (load.diagnostics?.length) {
      console.error(`[smoke] diagnostics (${load.diagnostics.length}):`);
      for (const d of load.diagnostics.slice(0, 10)) console.error(`  - ${d}`);
    }
    if (load.skipped?.length) {
      console.error(`[smoke] skipped (${load.skipped.length}):`);
      for (const s of load.skipped.slice(0, 10)) console.error(`  - ${s.path}: ${s.reason}`);
    }

    const sd = await send('shutdown', null);
    console.error(`[smoke] shutdown -> ${JSON.stringify(sd)}`);
    if (sd.accepted !== true) fail('shutdown not accepted');

    const wallMs = Date.now() - t0;
    console.error(`[smoke] PASS in ${wallMs} ms`);

    proc.on('exit', (code) => {
      console.error(`[smoke] child exit code=${code}`);
      process.exit(code === 0 ? 0 : 5);
    });
    // Give the server a beat to drain and exit on its own.
    setTimeout(() => {
      try { proc.kill(); } catch {}
      process.exit(0);
    }, 2000);
  } catch (err) {
    console.error('[smoke] ERROR:', err?.stack ?? err);
    try { proc.kill(); } catch {}
    process.exit(1);
  }
})();
