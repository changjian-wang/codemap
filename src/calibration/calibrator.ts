import type {
  CodeNode,
  CodeEdge,
  MethodInfo,
  RiskType,
  VerificationState,
} from '../shared/types';
import type { SymbolProvider, SymbolHit } from './symbol-provider';

/**
 * Bump when the calibrator's verdict logic changes (not just prompt text).
 * Folded into the analyzer cache key so cached AnalyzeResults built under
 * the old logic are invalidated automatically.
 *
 * History:
 *   v1 — initial
 *   v2 — symmetric generic-stripping in bestSymbolMatch (Foo<T> <-> Foo)
 */
export const CALIBRATOR_VERSION = 'v2';

/**
 * Calibrator: LLM raw output → validated CodeNode + CodeEdge[].
 *
 * Per the v3 plan §5.4 unchanged from v2:
 *   - verified   = node_id present in DocumentSymbol AND all `calls`
 *                  targets present (in-file). external_calls findable via
 *                  workspace symbol search.
 *   - partial    = node_id present, but at least one calls target dropped
 *                  OR at least one external_call failed soft validation
 *                  OR LLM-supplied range was off and got rewritten.
 *   - unverified = node_id not found in workspace at all. Node still
 *                  surfaces in the graph as a grey ghost so the user
 *                  knows the LLM mentioned it, but jumps are disabled.
 *
 * This module is pure — it takes a SymbolProvider, never touches `vscode`.
 */

export interface RawCalibratorInput {
  /** Output of CodemapMetaStreamParser, kind:'meta', data:unknown. */
  data: unknown;
  /** Workspace-relative file path the analyzer was given. */
  file: string;
  /** Bounded context bucket (from bc-classifier). */
  boundedContext: string;
}

export interface CalibrationResult {
  node: CodeNode;
  edges: CodeEdge[];
}

/**
 * Best-effort field access against an `unknown` payload from the LLM.
 * We deliberately reach into the JSON without zod / runtime schema — the
 * cost of one bad field is a defaulted value, not a thrown error.
 */
function asString(o: unknown, k: string): string | undefined {
  const v = (o as Record<string, unknown>)?.[k];
  return typeof v === 'string' ? v : undefined;
}
function asNumber(o: unknown, k: string): number | undefined {
  const v = (o as Record<string, unknown>)?.[k];
  return typeof v === 'number' ? v : undefined;
}
function asArray(o: unknown, k: string): unknown[] {
  const v = (o as Record<string, unknown>)?.[k];
  return Array.isArray(v) ? v : [];
}
function asObject(o: unknown, k: string): Record<string, unknown> | undefined {
  const v = (o as Record<string, unknown>)?.[k];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const VALID_RISKS = new Set<RiskType>([
  'security',
  'external_io',
  'concurrency',
  'low_confidence',
  'high_coupling',
  'missing_test',
]);

function parseRisks(raw: unknown[]): { type: RiskType; desc: string }[] {
  return raw
    .map(r => {
      if (typeof r === 'string' && VALID_RISKS.has(r as RiskType)) {
        return { type: r as RiskType, desc: '' };
      }
      if (r && typeof r === 'object') {
        const t = (r as Record<string, unknown>).type;
        const d = (r as Record<string, unknown>).desc;
        if (typeof t === 'string' && VALID_RISKS.has(t as RiskType)) {
          return { type: t as RiskType, desc: typeof d === 'string' ? d : '' };
        }
      }
      return undefined;
    })
    .filter((x): x is { type: RiskType; desc: string } => x !== undefined);
}

function parseRiskTags(raw: unknown[]): RiskType[] {
  return raw
    .filter((r): r is string => typeof r === 'string' && VALID_RISKS.has(r as RiskType))
    .map(r => r as RiskType);
}

function bestSymbolMatch(name: string, hits: SymbolHit[]): SymbolHit | undefined {
  const exact = hits.find(h => h.name === name);
  if (exact) return exact;
  // Generic-stripped match — bidirectional because the LLM may emit `Foo<T>`
  // (and LSP returns `Foo`) OR the LLM may emit `Foo` (and the C# LSP returns
  // `Foo<T>` with type parameters baked into the DocumentSymbol name).
  const strip = (s: string) => s.replace(/<.*>$/, '');
  const strippedName = strip(name);
  return hits.find(h => strip(h.name) === strippedName);
}

export class Calibrator {
  constructor(private symbols: SymbolProvider) {}

  async calibrate(input: RawCalibratorInput): Promise<CalibrationResult | undefined> {
    const { data, file, boundedContext } = input;

    const nodeId = asString(data, 'node_id');
    if (!nodeId) return undefined; // skip malformed entries — they shouldn't appear in the graph at all

    // ---- 1. Locate the class in the file. ----
    const inFileSymbols = await this.symbols.symbolsInFile(file);
    const lspNotReady = inFileSymbols === undefined;
    const safeSymbols = inFileSymbols ?? [];
    const symbol = bestSymbolMatch(nodeId, safeSymbols);

    let verification: VerificationState = 'verified';
    const rangeObj = asObject(data, 'range');
    const rangeFromLlm = {
      startLine: asNumber(rangeObj, 'startLine') ?? 1,
      endLine: asNumber(rangeObj, 'endLine') ?? 1,
    };

    let range = rangeFromLlm;
    let rangeAdjusted = false;
    if (!symbol) {
      // Two cases: (a) LSP responded with [] → the file has no symbols, the
      // class genuinely does not exist, mark unverified; (b) LSP did not
      // respond (lspNotReady) → no signal ≠ negative signal, keep verified
      // and let the orchestrator's chat warning explain the situation.
      if (!lspNotReady) {
        verification = 'unverified';
      }
    } else {
      // LSP wins. The diff against LLM-provided range is the rangeAdjusted flag.
      if (
        symbol.startLine !== rangeFromLlm.startLine ||
        symbol.endLine !== rangeFromLlm.endLine
      ) {
        rangeAdjusted = true;
      }
      range = { startLine: symbol.startLine, endLine: symbol.endLine };
    }

    // ---- 2. Sort `calls` targets into in-file (verified) vs cross-file
    //         (unverified pending aggregator resolution).
    //
    // Per the v3 prompt contract `calls` is "in-file class names". LLMs leak
    // cross-file refs here regardless, and the v3 plan explicitly says the
    // aggregator resolves cross-file `calls` via workspace symbol lookup. So
    // the calibrator does what it can see (in-file LSP) and hands the rest
    // off as verified=false; the aggregator does the second-stage validation.
    // When the LSP is not ready, we cannot tell in-file from cross-file at
    // all, so we hand every target to the aggregator as verified=false.
    const verifiedCalls: string[] = [];
    const unverifiedCalls: string[] = [];
    for (const t of asArray(data, 'calls')) {
      if (typeof t !== 'string') continue;
      const className = t.split('.')[0]!;
      if (!lspNotReady && bestSymbolMatch(className, safeSymbols)) {
        verifiedCalls.push(className);
      } else {
        unverifiedCalls.push(className);
      }
    }
    // droppedCalls stays empty at the calibrator layer; the aggregator
    // populates it on its side when workspace lookup also fails.
    const droppedCalls: string[] = [];

    // ---- 3. Soft-validate `external_calls` against the workspace. ----
    // Every external_call still becomes an `ext:*` edge. Workspace symbol
    // search cannot see BCL / NuGet / pip / Maven types that are not
    // source-indexed, so a miss is *not* proof of hallucination — it just
    // means "the language server cannot locate this name in workspace
    // source". We record those misses on `droppedExternalCalls` for the
    // details panel, but we do NOT downgrade verification, because that
    // would mark virtually every SDK wrapper node as `partial` (NuGet
    // dependencies dominate `external_calls` and almost never resolve
    // through the workspace symbol provider).
    // When the LSP is not ready we cannot tell anything, so every entry is
    // accepted at face value.
    const verifiedExternal: string[] = [];
    const droppedExternal: string[] = [];
    for (const t of asArray(data, 'external_calls')) {
      if (typeof t !== 'string') continue;
      verifiedExternal.push(t);
      if (lspNotReady) continue;
      const last = t.split('.').pop()!;
      try {
        const hits = await this.symbols.findInWorkspace(last, 1);
        if (hits.length === 0) droppedExternal.push(t);
      } catch {
        // Treat lookup failure as "no signal" rather than a drop.
      }
    }

    // ---- 4. Build methods (no per-method calibration in W2; that's W3). ----
    const methods: MethodInfo[] = asArray(data, 'methods').map(m => ({
      name: asString(m, 'name') ?? '<unknown>',
      signature: asString(m, 'signature') ?? '()',
      line: asNumber(m, 'line') ?? 0,
      intent: asString(m, 'intent'),
      risks: parseRiskTags(asArray(m, 'risks')),
      calls: asArray(m, 'calls').filter((x): x is string => typeof x === 'string'),
      externalCalls: asArray(m, 'external_calls').filter(
        (x): x is string => typeof x === 'string',
      ),
    }));

    // ---- 5. Top-level fields with defaults. ----
    // Accept the four in-scope kinds; anything else (e.g. a hallucinated
    // "delegate" or "function") falls back to 'class' — the dependency
    // graph still reads correctly, only the visual stereotype is lost.
    const rawKind = asString(data, 'kind');
    const kind: CodeNode['kind'] =
      rawKind === 'enum' ? 'enum'
      : rawKind === 'interface' ? 'interface'
      : rawKind === 'record' ? 'record'
      : 'class';
    const node: CodeNode = {
      id: nodeId,
      kind,
      file,
      range,
      boundedContext,
      intent: asString(data, 'intent') ?? '',
      layer: (asString(data, 'layer') as CodeNode['layer']) ?? undefined,
      confidence: asNumber(data, 'confidence') ?? 0.5,
      risks: parseRisks(asArray(data, 'risks')),
      methods,
      readingPriority: asNumber(data, 'reading_priority') ?? 99,
      readState: 'unread',
      verification,
      verificationDetails: {
        rangeAdjusted,
        droppedCalls,
        droppedExternalCalls: droppedExternal,
        lspNotReady: lspNotReady || undefined,
        reason: lspNotReady
          ? 'Language server did not respond at calibration time; verification is provisional. Re-run after the LSP settles.'
          : undefined,
      },
    };

    const edges: CodeEdge[] = [
      ...verifiedCalls.map<CodeEdge>(to => ({
        from: nodeId,
        to,
        kind: 'calls',
        verified: true,
      })),
      ...unverifiedCalls.map<CodeEdge>(to => ({
        from: nodeId,
        to,
        kind: 'calls',
        verified: false,
      })),
      ...verifiedExternal.map<CodeEdge>(to => ({
        from: nodeId,
        to: `ext:${to}`,
        kind: 'external_calls',
        verified: true,
      })),
    ];

    return { node, edges };
  }
}
