// Phase 2.5 -- subprocess lifecycle for the C# calibrator.
//
// Responsibilities:
//   - Spawn the codemap-calibrator-csharp child process and complete the
//     `initialize` handshake before any caller can issue requests.
//   - Multiplex JSON-RPC over LSP framing on stdin/stdout.
//   - Auto-respawn on unexpected exit, with exponential backoff and a
//     hard ceiling of MAX_RESPAWN_ATTEMPTS per "stable window". A clean
//     run (process stays up for STABLE_WINDOW_MS) resets the counter.
//   - `dispose()` performs a graceful shutdown: send the `shutdown` RPC,
//     wait briefly for the child to exit on its own, then SIGTERM, then
//     SIGKILL as the final fallback. After dispose, auto-respawn is off.
//   - Requests issued while the host is between processes wait on the
//     next successful spawn (or fail if dispose has been called).
//
// The host owns no Roslyn / solution state beyond what the child holds.
// `loadSolution` state is lost on respawn -- callers must reload as part
// of their own recovery flow. (The orchestrator already treats solution
// state as derivable from workspace inputs, so this is fine.)

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  CalibratorMethod,
  PROTOCOL_VERSION,
  parseInitializeResult,
  parsePingResult,
  parseResolveCalleesResult,
  parseLoadSolutionResult,
  type CalibratorErrorEnvelope,
  type InitializeParams,
  type InitializeResult,
  type LoadSolutionParams,
  type LoadSolutionResult,
  type PingParams,
  type PingResult,
  type ResolveCalleesParams,
  type ResolveCalleesResult,
} from '../../shared/calibrator-protocol';
import { FrameDecoder, encodeFrame } from './rpc-framing';

const MAX_RESPAWN_ATTEMPTS = 3;
const BACKOFF_MS = [200, 800, 3200] as const;
const STABLE_WINDOW_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const GRACEFUL_SHUTDOWN_MS = 1_500;
const SIGTERM_GRACE_MS = 1_000;

export interface CSharpCalibratorHostOptions {
  /** Absolute path to the calibrator binary. */
  executable: string;
  /** Optional working directory; defaults to the binary's directory. */
  cwd?: string;
  /**
   * Workspace root passed to the calibrator's `initialize`. Used today
   * only for diagnostics, but reserved so we don't have to revisit the
   * spawn surface later.
   */
  workspaceRoot?: string;
  clientName?: string;
  /** Hook for tests to observe lifecycle events without coupling to logs. */
  onEvent?: (event: HostLifecycleEvent) => void;
}

export type HostLifecycleEvent =
  | { type: 'spawned'; pid: number; attempt: number }
  | { type: 'initialized'; result: InitializeResult }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'respawn-scheduled'; delayMs: number; attempt: number }
  | { type: 'respawn-giving-up'; reason: string }
  | { type: 'disposed' };

interface PendingRequest {
  resolve: (msg: { result?: unknown; error?: CalibratorErrorEnvelope }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

type LifecycleState = 'idle' | 'spawning' | 'ready' | 'restarting' | 'disposed';

export class CalibratorHostError extends Error {
  readonly envelope?: CalibratorErrorEnvelope;
  constructor(message: string, envelope?: CalibratorErrorEnvelope) {
    super(message);
    this.name = 'CalibratorHostError';
    this.envelope = envelope;
  }
}

export class CSharpCalibratorHost {
  private readonly opts: CSharpCalibratorHostOptions;
  private readonly emitter = new EventEmitter();
  private state: LifecycleState = 'idle';
  private proc: ChildProcessWithoutNullStreams | null = null;
  private decoder = new FrameDecoder();
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private respawnAttempt = 0;
  private spawnedAt = 0;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private respawnTimer: NodeJS.Timeout | null = null;

  constructor(opts: CSharpCalibratorHostOptions) {
    this.opts = opts;
    if (opts.onEvent) {
      this.emitter.on('event', opts.onEvent);
    }
  }

  /**
   * Spawn the child if not already running, run `initialize`, and resolve
   * once the server reports its capabilities. Idempotent: concurrent
   * callers share the same readiness promise.
   */
  async start(): Promise<void> {
    if (this.state === 'disposed') {
      throw new CalibratorHostError('host has been disposed');
    }
    if (this.state === 'ready') return;
    if (this.readyPromise) return this.readyPromise;
    this.spawnAndInitialize(0);
    return this.readyPromise ?? Promise.resolve();
  }

  /**
   * Send a JSON-RPC request and parse the typed result. Will auto-spawn
   * if the host has not been started yet (mirrors how the orchestrator
   * uses it lazily).
   */
  async ping(params: PingParams = {}): Promise<PingResult> {
    const reply = await this.request(CalibratorMethod.Ping, params);
    return parsePingResult(reply);
  }

  async loadSolution(params: LoadSolutionParams): Promise<LoadSolutionResult> {
    const reply = await this.request(CalibratorMethod.LoadSolution, params, 180_000);
    return parseLoadSolutionResult(reply);
  }

  async resolveCallees(params: ResolveCalleesParams): Promise<ResolveCalleesResult> {
    const reply = await this.request(CalibratorMethod.ResolveCallees, params);
    return parseResolveCalleesResult(reply);
  }

  /** Currently-attached pid, useful for tests that need to SIGKILL. */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  /**
   * Gracefully tear down the child. Safe to call multiple times. After
   * dispose the host is terminal -- create a new instance to use it again.
   */
  async dispose(): Promise<void> {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    const proc = this.proc;
    this.proc = null;
    this.failAllPending(new CalibratorHostError('host disposed'));

    if (!proc) {
      this.emit({ type: 'disposed' });
      return;
    }

    const exited = new Promise<void>((res) => {
      proc.once('exit', () => res());
    });

    // Best-effort graceful shutdown. We deliberately don't go through
    // this.request -- the host is in `disposed` state, so request() would
    // reject. Send the raw frame and let the timeouts below handle the
    // rest.
    try {
      const frame = encodeFrame({
        jsonrpc: '2.0',
        id: this.nextId++,
        method: CalibratorMethod.Shutdown,
        params: {},
      });
      proc.stdin.write(frame);
    } catch {
      // child may already be dying; ignore
    }

    const sigterm = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }, GRACEFUL_SHUTDOWN_MS);
    const sigkill = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, GRACEFUL_SHUTDOWN_MS + SIGTERM_GRACE_MS);

    await exited;
    clearTimeout(sigterm);
    clearTimeout(sigkill);
    this.emit({ type: 'disposed' });
  }

  // ---- private --------------------------------------------------------

  private async request(
    method: string,
    params: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.state === 'disposed') {
      throw new CalibratorHostError('host has been disposed');
    }
    if (this.state !== 'ready') {
      await this.start();
    }
    if (this.state !== 'ready' || !this.proc) {
      throw new CalibratorHostError(`host not ready (state=${this.state})`);
    }

    const id = this.nextId++;
    const frame = encodeFrame({ jsonrpc: '2.0', id, method, params });
    const proc = this.proc;

    return new Promise<unknown>((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectP(new CalibratorHostError(`timeout ${timeoutMs}ms on ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        timer,
        resolve: (msg) => {
          if (msg.error) {
            rejectP(new CalibratorHostError(msg.error.message, msg.error));
          } else {
            resolveP(msg.result);
          }
        },
        reject: rejectP,
      });

      try {
        proc.stdin.write(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectP(
          new CalibratorHostError(
            `failed to write request ${method}: ${(err as Error).message}`,
          ),
        );
      }
    });
  }

  private spawnAndInitialize(attempt: number): void {
    if (this.state === 'disposed') return;
    this.state = 'spawning';
    this.respawnAttempt = attempt;

    this.readyPromise = new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });

    const proc = spawn(this.opts.executable, [], {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.decoder.reset();
    this.spawnedAt = Date.now();
    this.emit({ type: 'spawned', pid: proc.pid ?? -1, attempt });

    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    // Drain stderr so the OS buffer never fills and back-pressures the
    // child. We don't surface it; consumers can attach their own logger.
    proc.stderr.on('data', () => {});

    proc.once('exit', (code, signal) => this.onExit(code, signal));
    proc.once('error', (err) => {
      const wrapped = new CalibratorHostError(`spawn error: ${err.message}`);
      this.failAllPending(wrapped);
      if (this.readyReject) {
        const reject = this.readyReject;
        this.readyResolve = null;
        this.readyReject = null;
        reject(wrapped);
      }
    });

    void this.runInitialize();
  }

  private async runInitialize(): Promise<void> {
    const id = this.nextId++;
    const params: InitializeParams = {
      workspaceRoot: this.opts.workspaceRoot,
      clientName: this.opts.clientName ?? 'codemap-extension',
    };
    const reply = await this.sendDirect(id, CalibratorMethod.Initialize, params, 30_000).catch(
      (err: Error) => err,
    );

    if (reply instanceof Error) {
      this.failReadiness(reply);
      return;
    }
    if (reply.error) {
      this.failReadiness(new CalibratorHostError(reply.error.message, reply.error));
      return;
    }
    try {
      const result = parseInitializeResult(reply.result);
      if (result.protocolVersion !== PROTOCOL_VERSION) {
        this.failReadiness(
          new CalibratorHostError(
            `protocol version mismatch: client=${PROTOCOL_VERSION} server=${result.protocolVersion}`,
          ),
        );
        return;
      }
      this.state = 'ready';
      this.emit({ type: 'initialized', result });
      const resolveReady = this.readyResolve;
      this.readyResolve = null;
      this.readyReject = null;
      if (resolveReady) resolveReady();
    } catch (err) {
      this.failReadiness(err as Error);
    }
  }

  /**
   * Bypass the normal `request` path so we can issue `initialize` while
   * state is still `spawning`. Otherwise structurally identical.
   */
  private sendDirect(
    id: number,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<{ result?: unknown; error?: CalibratorErrorEnvelope }> {
    const proc = this.proc;
    if (!proc) {
      return Promise.reject(new CalibratorHostError('no child process for sendDirect'));
    }
    const frame = encodeFrame({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectP(new CalibratorHostError(`timeout ${timeoutMs}ms on ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        timer,
        resolve: resolveP,
        reject: rejectP,
      });
      try {
        proc.stdin.write(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectP(
          new CalibratorHostError(
            `failed to write ${method}: ${(err as Error).message}`,
          ),
        );
      }
    });
  }

  private onData(chunk: Buffer): void {
    const messages = this.decoder.push(chunk);
    for (const msg of messages) {
      const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      if (!Number.isFinite(id)) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve({
        result: msg.result,
        error: msg.error as CalibratorErrorEnvelope | undefined,
      });
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit({ type: 'exit', code, signal });
    const wasReady = this.state === 'ready';
    const aliveMs = Date.now() - this.spawnedAt;
    this.proc = null;
    this.failAllPending(
      new CalibratorHostError(`calibrator exited (code=${code}, signal=${signal})`),
    );

    if (this.state === 'disposed') return;

    // Reset the attempt counter after a long-enough stable run.
    if (wasReady && aliveMs >= STABLE_WINDOW_MS) {
      this.respawnAttempt = 0;
    }

    const nextAttempt = this.respawnAttempt + 1;
    if (nextAttempt > MAX_RESPAWN_ATTEMPTS) {
      this.state = 'idle';
      this.emit({
        type: 'respawn-giving-up',
        reason: `exceeded MAX_RESPAWN_ATTEMPTS=${MAX_RESPAWN_ATTEMPTS}`,
      });
      // Reject any in-flight readiness promise.
      if (this.readyReject) {
        const reject = this.readyReject;
        this.readyResolve = null;
        this.readyReject = null;
        reject(
          new CalibratorHostError(
            `calibrator failed to stay alive after ${MAX_RESPAWN_ATTEMPTS} attempts`,
          ),
        );
      }
      return;
    }

    const delayMs = BACKOFF_MS[Math.min(nextAttempt - 1, BACKOFF_MS.length - 1)];
    this.state = 'restarting';
    this.emit({ type: 'respawn-scheduled', delayMs, attempt: nextAttempt });
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (this.state === 'disposed') return;
      this.spawnAndInitialize(nextAttempt);
    }, delayMs);
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private failReadiness(err: Error): void {
    const reject = this.readyReject;
    this.readyResolve = null;
    this.readyReject = null;
    // Push the failure through the same code path as a crash so backoff
    // / give-up logic stays in one place.
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // ignore -- exit handler will run
      }
    }
    if (reject) reject(err);
  }

  private emit(event: HostLifecycleEvent): void {
    this.emitter.emit('event', event);
  }
}
