// Phase 2.4 -- contract round-trip integration test.
//
// Spawns the built C# calibrator binary, sends LSP-framed JSON-RPC over
// stdio using the typed shapes from src/shared/calibrator-protocol.ts,
// and asserts that every response parses cleanly against the protocol's
// validators. This is the only place where the TS contract is verified
// against the actual wire format produced by StreamJsonRpc + the C#
// records.
//
// The test gracefully SKIPS when the calibrator binary is not present
// (typical for a fresh clone before `dotnet build`). Run the calibrator
// build first to exercise it: `dotnet build tools/codemap-calibrator-csharp`.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  CalibratorMethod,
  parseInitializeResult,
  parsePingResult,
  parseShutdownResult,
  parseErrorEnvelope,
  PROTOCOL_VERSION,
  type CalibratorErrorEnvelope,
} from '../../src/shared/calibrator-protocol';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CALIBRATOR_EXE = resolve(
  __dirname,
  '../../tools/codemap-calibrator-csharp/bin/Debug/net8.0/codemap-calibrator-csharp',
);

const describeIfBuilt = existsSync(CALIBRATOR_EXE) ? describe : describe.skip;

class RpcClient {
  private proc: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: CalibratorErrorEnvelope }) => void>();

  constructor(exe: string) {
    this.proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    // Calibrator's stderr is diagnostic only; capture but don't fail the
    // test on it (the StreamJsonRpc tracer logs at Warning here).
    this.proc.stderr.on('data', () => {});
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) throw new Error(`malformed header: ${header}`);
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) return;
      const body = this.buf.subarray(bodyStart, bodyStart + len).toString('utf8');
      this.buf = this.buf.subarray(bodyStart + len);
      const msg = JSON.parse(body) as {
        id: number;
        result?: unknown;
        error?: CalibratorErrorEnvelope;
      };
      const resolver = this.pending.get(msg.id);
      if (resolver) {
        this.pending.delete(msg.id);
        resolver(msg);
      }
    }
  }

  send(method: string, params: unknown, timeoutMs = 10000): Promise<{ result?: unknown; error?: CalibratorErrorEnvelope }> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const frame = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectP(new Error(`timeout ${timeoutMs}ms on ${method}`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveP(msg);
      });
      this.proc.stdin.write(frame);
    });
  }

  async dispose(): Promise<void> {
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
  }
}

describeIfBuilt('calibrator protocol round-trip', () => {
  let client: RpcClient;

  beforeAll(() => {
    client = new RpcClient(CALIBRATOR_EXE);
  });

  afterAll(async () => {
    await client.dispose();
  });

  it('initialize returns a parseable InitializeResult', async () => {
    const reply = await client.send(CalibratorMethod.Initialize, {
      workspaceRoot: __dirname,
      clientName: 'protocol-roundtrip',
    });
    expect(reply.error).toBeUndefined();
    const result = parseInitializeResult(reply.result);
    expect(result.serverName).toBe('codemap-calibrator-csharp');
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(typeof result.capabilities.slnxLoading).toBe('boolean');
    expect(typeof result.capabilities.resolveCallees).toBe('boolean');
  });

  it('ping echoes token and reports initialized', async () => {
    const reply = await client.send(CalibratorMethod.Ping, { token: 'roundtrip' });
    expect(reply.error).toBeUndefined();
    const result = parsePingResult(reply.result);
    expect(result.echo).toBe('roundtrip');
    expect(result.initialized).toBe(true);
    expect(result.serverTimestampMs).toBeGreaterThan(0);
  });

  it('resolveCallees before loadSolution returns a parseable error envelope', async () => {
    // We deliberately call resolveCallees with no prior loadSolution to
    // trigger the InvalidOperationException raised by CalibratorService.
    // This proves the *error* half of the contract round-trips too.
    const reply = await client.send(CalibratorMethod.ResolveCallees, {
      filePath: '/nonexistent.cs',
      line: 1,
      classId: 'X',
      methodName: 'Y',
    });
    expect(reply.result).toBeUndefined();
    const err = parseErrorEnvelope(reply.error);
    expect(err.code).toBeLessThan(0); // JSON-RPC error codes are negative
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.message.toLowerCase()).toContain('loadsolution');
  });

  it('shutdown is accepted', async () => {
    const reply = await client.send(CalibratorMethod.Shutdown, {});
    expect(reply.error).toBeUndefined();
    const result = parseShutdownResult(reply.result);
    expect(result.accepted).toBe(true);
  });
});
