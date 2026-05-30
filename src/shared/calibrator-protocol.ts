// Phase 2.4 -- IPC contract between the TypeScript extension host and any
// CalibratorService implementation (currently codemap-calibrator-csharp,
// later also the in-process ts-morph calibrator).
//
// This file is the *only* coupling point between the orchestrator and the
// calibrator subprocess. Both sides must round-trip every shape declared
// here; the round-trip integration test in test/integration/ enforces it.
//
// We do not pull zod -- one schema file does not justify ~200 KB of
// extension bundle. Validation is hand-rolled `assert*` helpers that
// throw `CalibratorProtocolError` on shape mismatch, with the same
// semantics zod's `.parse` would give us.

export const PROTOCOL_VERSION = 1 as const;

// =========================================================================
//   Method names (single source of truth, used by both sides)
// =========================================================================

export const CalibratorMethod = {
  Initialize: 'initialize',
  Ping: 'ping',
  LoadSolution: 'loadSolution',
  ResolveCallees: 'resolveCallees',
  Shutdown: 'shutdown',
} as const;
export type CalibratorMethod = (typeof CalibratorMethod)[keyof typeof CalibratorMethod];

// =========================================================================
//   Capabilities + server info
// =========================================================================

export interface ServerCapabilities {
  slnxLoading: boolean;
  resolveCallees: boolean;
}

export interface InitializeParams {
  workspaceRoot?: string;
  clientName?: string;
}

export interface InitializeResult {
  serverName: string;
  serverVersion: string;
  protocolVersion: number;
  capabilities: ServerCapabilities;
}

// =========================================================================
//   Liveness
// =========================================================================

export interface PingParams {
  token?: string;
}

export interface PingResult {
  echo: string;
  serverTimestampMs: number;
  initialized: boolean;
}

// =========================================================================
//   loadSolution
// =========================================================================

export interface LoadSolutionParams {
  slnxPath: string;
}

export interface LoadedProject {
  name: string;
  filePath: string;
  language: string;
  assemblyName: string;
}

export interface SkippedProject {
  path: string;
  reason: string;
}

export interface LoadSolutionResult {
  slnxPath: string;
  declaredProjectCount: number;
  loadedProjectCount: number;
  distinctProjectCount: number;
  projects: LoadedProject[];
  skipped: SkippedProject[];
  diagnostics: string[];
  elapsedMs: number;
}

// =========================================================================
//   resolveCallees
// =========================================================================

export type CalleeKind = 'method' | 'constructor' | 'extension' | 'localFunction' | 'unknown';

export interface ResolveCalleesParams {
  filePath: string;
  /** 1-based source line where the method declaration starts. */
  line: number;
  /**
   * Class id from the v2 graph shape. Bare class name preferred, but
   * fully qualified is also accepted by the C# resolver.
   */
  classId: string;
  methodName: string;
}

export interface Callee {
  /** Pretty display string, e.g. `IRecallQuery.SearchAsync(Vector, ...)`. */
  displayName: string;
  /** FQN suitable for graph id construction. */
  fullyQualifiedName: string;
  /** Empty string when the symbol has no containing type (free function). */
  containingType: string;
  methodName: string;
  kind: CalleeKind;
  /** True when every declaration location is metadata-only (BCL / NuGet). */
  isExternal: boolean;
  isExtension: boolean;
  /** Source file of the target declaration; null when external. */
  filePath: string | null;
  /** 1-based declaration line of the target; null when external. */
  line: number | null;
  /** 1-based line in the *caller* file where the invocation appears. */
  invocationLine: number;
}

export interface ResolveCalleesResult {
  filePath: string;
  classId: string;
  methodName: string;
  methodFullyQualifiedName: string;
  callees: Callee[];
  elapsedMs: number;
}

// =========================================================================
//   shutdown
// =========================================================================

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ShutdownParams {}

export interface ShutdownResult {
  accepted: boolean;
}

// =========================================================================
//   Error envelope (subset of JSON-RPC 2.0 error)
// =========================================================================

export interface CalibratorErrorEnvelope {
  code: number;
  message: string;
  data?: {
    type?: string;
    message?: string;
    stack?: string;
    code?: number;
  };
}

export class CalibratorProtocolError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`[calibrator-protocol] ${path}: ${message}`);
    this.path = path;
    this.name = 'CalibratorProtocolError';
  }
}

// =========================================================================
//   Request <-> handler map
// =========================================================================

export interface CalibratorRequestMap {
  [CalibratorMethod.Initialize]: { params: InitializeParams; result: InitializeResult };
  [CalibratorMethod.Ping]: { params: PingParams; result: PingResult };
  [CalibratorMethod.LoadSolution]: { params: LoadSolutionParams; result: LoadSolutionResult };
  [CalibratorMethod.ResolveCallees]: { params: ResolveCalleesParams; result: ResolveCalleesResult };
  [CalibratorMethod.Shutdown]: { params: ShutdownParams; result: ShutdownResult };
}

export type CalibratorRequest<M extends CalibratorMethod = CalibratorMethod> = {
  jsonrpc: '2.0';
  id: number | string;
  method: M;
  params: CalibratorRequestMap[M]['params'];
};

export type CalibratorResponse<M extends CalibratorMethod = CalibratorMethod> =
  | {
      jsonrpc: '2.0';
      id: number | string;
      result: CalibratorRequestMap[M]['result'];
    }
  | {
      jsonrpc: '2.0';
      id: number | string;
      error: CalibratorErrorEnvelope;
    };

// =========================================================================
//   Validators
// =========================================================================

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== 'string') {
    throw new CalibratorProtocolError(`${path}.${key}`, `expected string, got ${typeof v}`);
  }
  return v;
}

function expectStringOrNull(obj: Record<string, unknown>, key: string, path: string): string | null {
  const v = obj[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') {
    throw new CalibratorProtocolError(`${path}.${key}`, `expected string|null, got ${typeof v}`);
  }
  return v;
}

function expectNumber(obj: Record<string, unknown>, key: string, path: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new CalibratorProtocolError(`${path}.${key}`, `expected number, got ${typeof v}`);
  }
  return v;
}

function expectNumberOrNull(obj: Record<string, unknown>, key: string, path: string): number | null {
  const v = obj[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new CalibratorProtocolError(`${path}.${key}`, `expected number|null, got ${typeof v}`);
  }
  return v;
}

function expectBoolean(obj: Record<string, unknown>, key: string, path: string): boolean {
  const v = obj[key];
  if (typeof v !== 'boolean') {
    throw new CalibratorProtocolError(`${path}.${key}`, `expected boolean, got ${typeof v}`);
  }
  return v;
}

function expectArray<T>(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  itemParser: (item: unknown, itemPath: string) => T,
): T[] {
  const v = obj[key];
  if (!Array.isArray(v)) {
    throw new CalibratorProtocolError(`${path}.${key}`, `expected array, got ${typeof v}`);
  }
  return v.map((item, i) => itemParser(item, `${path}.${key}[${i}]`));
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new CalibratorProtocolError(path, `expected object, got ${value === null ? 'null' : typeof value}`);
  }
  return value;
}

const VALID_CALLEE_KINDS = new Set<CalleeKind>([
  'method',
  'constructor',
  'extension',
  'localFunction',
  'unknown',
]);

function parseCallee(value: unknown, path: string): Callee {
  const obj = expectObject(value, path);
  const kind = expectString(obj, 'kind', path);
  if (!VALID_CALLEE_KINDS.has(kind as CalleeKind)) {
    throw new CalibratorProtocolError(`${path}.kind`, `unknown CalleeKind: ${kind}`);
  }
  return {
    displayName: expectString(obj, 'displayName', path),
    fullyQualifiedName: expectString(obj, 'fullyQualifiedName', path),
    containingType: expectString(obj, 'containingType', path),
    methodName: expectString(obj, 'methodName', path),
    kind: kind as CalleeKind,
    isExternal: expectBoolean(obj, 'isExternal', path),
    isExtension: expectBoolean(obj, 'isExtension', path),
    filePath: expectStringOrNull(obj, 'filePath', path),
    line: expectNumberOrNull(obj, 'line', path),
    invocationLine: expectNumber(obj, 'invocationLine', path),
  };
}

function parseLoadedProject(value: unknown, path: string): LoadedProject {
  const obj = expectObject(value, path);
  return {
    name: expectString(obj, 'name', path),
    filePath: expectString(obj, 'filePath', path),
    language: expectString(obj, 'language', path),
    assemblyName: expectString(obj, 'assemblyName', path),
  };
}

function parseSkippedProject(value: unknown, path: string): SkippedProject {
  const obj = expectObject(value, path);
  return {
    path: expectString(obj, 'path', path),
    reason: expectString(obj, 'reason', path),
  };
}

export function parseInitializeResult(value: unknown): InitializeResult {
  const obj = expectObject(value, 'InitializeResult');
  const caps = expectObject(obj['capabilities'], 'InitializeResult.capabilities');
  return {
    serverName: expectString(obj, 'serverName', 'InitializeResult'),
    serverVersion: expectString(obj, 'serverVersion', 'InitializeResult'),
    protocolVersion: expectNumber(obj, 'protocolVersion', 'InitializeResult'),
    capabilities: {
      slnxLoading: expectBoolean(caps, 'slnxLoading', 'InitializeResult.capabilities'),
      resolveCallees: expectBoolean(caps, 'resolveCallees', 'InitializeResult.capabilities'),
    },
  };
}

export function parsePingResult(value: unknown): PingResult {
  const obj = expectObject(value, 'PingResult');
  return {
    echo: expectString(obj, 'echo', 'PingResult'),
    serverTimestampMs: expectNumber(obj, 'serverTimestampMs', 'PingResult'),
    initialized: expectBoolean(obj, 'initialized', 'PingResult'),
  };
}

export function parseLoadSolutionResult(value: unknown): LoadSolutionResult {
  const obj = expectObject(value, 'LoadSolutionResult');
  return {
    slnxPath: expectString(obj, 'slnxPath', 'LoadSolutionResult'),
    declaredProjectCount: expectNumber(obj, 'declaredProjectCount', 'LoadSolutionResult'),
    loadedProjectCount: expectNumber(obj, 'loadedProjectCount', 'LoadSolutionResult'),
    distinctProjectCount: expectNumber(obj, 'distinctProjectCount', 'LoadSolutionResult'),
    projects: expectArray(obj, 'projects', 'LoadSolutionResult', parseLoadedProject),
    skipped: expectArray(obj, 'skipped', 'LoadSolutionResult', parseSkippedProject),
    diagnostics: expectArray(obj, 'diagnostics', 'LoadSolutionResult', (v, p) => {
      if (typeof v !== 'string') {
        throw new CalibratorProtocolError(p, `expected string, got ${typeof v}`);
      }
      return v;
    }),
    elapsedMs: expectNumber(obj, 'elapsedMs', 'LoadSolutionResult'),
  };
}

export function parseResolveCalleesResult(value: unknown): ResolveCalleesResult {
  const obj = expectObject(value, 'ResolveCalleesResult');
  return {
    filePath: expectString(obj, 'filePath', 'ResolveCalleesResult'),
    classId: expectString(obj, 'classId', 'ResolveCalleesResult'),
    methodName: expectString(obj, 'methodName', 'ResolveCalleesResult'),
    methodFullyQualifiedName: expectString(obj, 'methodFullyQualifiedName', 'ResolveCalleesResult'),
    callees: expectArray(obj, 'callees', 'ResolveCalleesResult', parseCallee),
    elapsedMs: expectNumber(obj, 'elapsedMs', 'ResolveCalleesResult'),
  };
}

export function parseShutdownResult(value: unknown): ShutdownResult {
  const obj = expectObject(value, 'ShutdownResult');
  return { accepted: expectBoolean(obj, 'accepted', 'ShutdownResult') };
}

export function parseErrorEnvelope(value: unknown): CalibratorErrorEnvelope {
  const obj = expectObject(value, 'CalibratorErrorEnvelope');
  const envelope: CalibratorErrorEnvelope = {
    code: expectNumber(obj, 'code', 'CalibratorErrorEnvelope'),
    message: expectString(obj, 'message', 'CalibratorErrorEnvelope'),
  };
  if (obj['data'] !== undefined && obj['data'] !== null) {
    const data = expectObject(obj['data'], 'CalibratorErrorEnvelope.data');
    envelope.data = {};
    if (typeof data['type'] === 'string') envelope.data.type = data['type'];
    if (typeof data['message'] === 'string') envelope.data.message = data['message'];
    if (typeof data['stack'] === 'string') envelope.data.stack = data['stack'];
    if (typeof data['code'] === 'number') envelope.data.code = data['code'];
  }
  return envelope;
}
