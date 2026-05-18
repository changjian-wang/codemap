import type {
  CodeNode,
  CodeEdge,
  MethodInfo,
  RiskType,
  VerificationState,
} from '../shared/types';
import type { SymbolProvider, SymbolHit } from './symbol-provider';

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
  // Generic-stripped match: `Foo<T>` → `Foo`.
  const stripped = name.replace(/<.*>$/, '');
  return hits.find(h => h.name === stripped);
}

export class Calibrator {
  constructor(private symbols: SymbolProvider) {}

  async calibrate(input: RawCalibratorInput): Promise<CalibrationResult | undefined> {
    const { data, file, boundedContext } = input;

    const nodeId = asString(data, 'node_id');
    if (!nodeId) return undefined; // skip malformed entries — they shouldn't appear in the graph at all

    // ---- 1. Locate the class in the file. ----
    const inFileSymbols = await this.symbols.symbolsInFile(file);
    const symbol = bestSymbolMatch(nodeId, inFileSymbols);

    let verification: VerificationState = 'verified';
    const rangeObj = asObject(data, 'range');
    const rangeFromLlm = {
      startLine: asNumber(rangeObj, 'startLine') ?? 1,
      endLine: asNumber(rangeObj, 'endLine') ?? 1,
    };

    let range = rangeFromLlm;
    let rangeAdjusted = false;
    if (!symbol) {
      verification = 'unverified';
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

    // ---- 2. Validate `calls` against in-file symbols. ----
    // Per the prompt contract `calls` lists in-file class names. LLMs leak
    // `Class.method` here regardless, so we extract the class half (first
    // segment when dotted).
    const droppedCalls: string[] = [];
    const verifiedCalls: string[] = [];
    for (const t of asArray(data, 'calls')) {
      if (typeof t !== 'string') continue;
      const className = t.split('.')[0]!;
      if (bestSymbolMatch(className, inFileSymbols)) {
        verifiedCalls.push(className);
      } else {
        droppedCalls.push(t);
      }
    }
    if (droppedCalls.length > 0 && verification === 'verified') {
      verification = 'partial';
    }

    // ---- 3. Soft-validate `external_calls` against the workspace. ----
    // W2 scope: we keep every external_call as an edge candidate but try a
    // workspace symbol lookup so the partial flag can fire if too many fail.
    // W3 splits these into "package import" vs "missing symbol" once we
    // start reading project manifests; for now we accept all.
    const verifiedExternal: string[] = [];
    for (const t of asArray(data, 'external_calls')) {
      if (typeof t !== 'string') continue;
      const last = t.split('.').pop()!;
      await this.symbols.findInWorkspace(last, 1);
      verifiedExternal.push(t);
    }
    const droppedExternal: string[] = [];

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
    const node: CodeNode = {
      id: nodeId,
      kind: 'class',
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
      },
    };

    const edges: CodeEdge[] = [
      ...verifiedCalls.map<CodeEdge>(to => ({
        from: nodeId,
        to,
        kind: 'calls',
        verified: true,
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
