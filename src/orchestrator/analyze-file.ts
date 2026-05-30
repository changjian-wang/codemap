// Phase 3.1 -- single-file LLM analyzer.
//
// Drives an LLM through the analyzer prompt and returns v2-shaped
// ClassNode + MethodNode arrays for the file. This slice produces ONE
// file at a time -- multi-file aggregation into a CodeMapGraph is the
// orchestrator's next job (Phase 3.2+).
//
// Calibration is NOT performed here: every returned node gets
// `verification: 'unverified'`. Edges are not produced at all (those
// come from CalibratorService.resolveCallees in a later pass).
//
// Fields the LLM does not see are filled with safe defaults:
//   ClassNode.boundedContext = ''   (Phase 3.2 BC classifier fills)
//   ClassNode.file            = AnalyzeInput.filePath
//   ClassNode.verification    = 'unverified'
//   MethodNode.verification   = 'unverified'

import type { ClassNode, MethodNode, NodeKind, RiskType, Visibility } from '../shared/types';
import {
  buildUserMessage,
  SYSTEM_PROMPT,
  type LlmClassNodeFragment,
  type LlmMethodNodeFragment,
  type MetaBlockPayload,
  type SummaryBlockPayload,
} from './analyzer-prompt';
import type { LlmClient } from './llm-client';
import { FencedBlockParser, type FencedBlock, type ParseError } from './stream-parser';

export interface AnalyzeInput {
  /** Workspace-relative path (used as the ClassNode.file value). */
  filePath: string;
  fileText: string;
  /** VS Code languageId, e.g. 'csharp' / 'typescript'. Informational only. */
  languageId: string;
  signal?: AbortSignal;
}

export interface AnalyzeResult {
  filePath: string;
  classes: ClassNode[];
  methods: MethodNode[];
  rootIntent?: string;
  narrative?: string;
  /** Raw LLM output, retained for debugging. */
  rawResponse: string;
  /** Non-fatal validation problems; the analyzer keeps whatever DID parse. */
  parseErrors: ParseError[];
}

const VALID_NODE_KINDS = new Set<NodeKind>(['class', 'interface', 'record', 'enum', 'struct']);
const VALID_VISIBILITY = new Set<Visibility>(['public', 'private', 'protected', 'internal']);
const VALID_RISK_TYPES = new Set<RiskType>([
  'security',
  'external_io',
  'concurrency',
  'low_confidence',
  'high_coupling',
  'missing_test',
]);

export async function analyzeFile(input: AnalyzeInput, llm: LlmClient): Promise<AnalyzeResult> {
  const parseErrors: ParseError[] = [];
  const parser = new FencedBlockParser({ onError: (e) => parseErrors.push(e) });
  let raw = '';

  const userMessage = buildUserMessage(input.filePath, input.fileText);
  const stream = llm.stream({
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    signal: input.signal,
  });

  const blocks: FencedBlock[] = [];
  for await (const fragment of stream) {
    raw += fragment;
    blocks.push(...parser.feed(fragment));
  }
  parser.flush();

  const meta = blocks.findLast((b) => b.kind === 'meta');
  const summary = blocks.findLast((b) => b.kind === 'summary');

  const classes: ClassNode[] = [];
  const methods: MethodNode[] = [];

  if (meta) {
    const validated = validateMetaBlock(meta.data, parseErrors);
    if (validated) {
      for (const c of validated.classes) {
        classes.push(toClassNode(c, input.filePath));
      }
      for (const m of validated.methods) {
        methods.push(toMethodNode(m));
      }
      enforceMethodOwnership(classes, methods, parseErrors);
    }
  } else if (raw.trim().length > 0) {
    parseErrors.push({
      reason: 'No codemap-meta block found in LLM response',
      raw: raw.slice(0, 500),
    });
  }

  let rootIntent: string | undefined;
  let narrative: string | undefined;
  if (summary) {
    const s = validateSummaryBlock(summary.data, parseErrors);
    if (s) {
      rootIntent = s.rootIntent;
      narrative = s.narrative;
    }
  }

  return {
    filePath: input.filePath,
    classes,
    methods,
    rootIntent,
    narrative,
    rawResponse: raw,
    parseErrors,
  };
}

// -------------------------------------------------------------------------
//   validation
// -------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateMetaBlock(data: unknown, errors: ParseError[]): MetaBlockPayload | undefined {
  if (!isObject(data)) {
    errors.push({ reason: 'meta block is not an object', raw: JSON.stringify(data).slice(0, 200) });
    return undefined;
  }
  const classes: LlmClassNodeFragment[] = [];
  const methods: LlmMethodNodeFragment[] = [];

  const rawClasses = data['classes'];
  if (!Array.isArray(rawClasses)) {
    errors.push({ reason: 'meta.classes is not an array', raw: JSON.stringify(rawClasses).slice(0, 200) });
  } else {
    rawClasses.forEach((c, i) => {
      const parsed = validateClassFragment(c, `meta.classes[${i}]`, errors);
      if (parsed) classes.push(parsed);
    });
  }

  const rawMethods = data['methods'];
  if (!Array.isArray(rawMethods)) {
    errors.push({ reason: 'meta.methods is not an array', raw: JSON.stringify(rawMethods).slice(0, 200) });
  } else {
    rawMethods.forEach((m, i) => {
      const parsed = validateMethodFragment(m, `meta.methods[${i}]`, errors);
      if (parsed) methods.push(parsed);
    });
  }
  return { classes, methods };
}

function validateClassFragment(
  raw: unknown,
  path: string,
  errors: ParseError[]
): LlmClassNodeFragment | undefined {
  if (!isObject(raw)) {
    errors.push({ reason: `${path} is not an object`, raw: JSON.stringify(raw).slice(0, 200) });
    return undefined;
  }
  try {
    const id = expectString(raw, 'id', path);
    const kind = expectString(raw, 'kind', path);
    if (!VALID_NODE_KINDS.has(kind as NodeKind)) {
      throw new Error(`unknown NodeKind: ${kind}`);
    }
    const rangeRaw = raw['range'];
    if (!isObject(rangeRaw)) throw new Error('range is not an object');
    const range = {
      startLine: expectNumber(rangeRaw, 'startLine', `${path}.range`),
      endLine: expectNumber(rangeRaw, 'endLine', `${path}.range`),
    };
    const intent = expectString(raw, 'intent', path);
    const confidence = expectNumber(raw, 'confidence', path);
    const methodIdsRaw = raw['methodIds'];
    if (!Array.isArray(methodIdsRaw) || methodIdsRaw.some((x) => typeof x !== 'string')) {
      throw new Error('methodIds is not a string[]');
    }
    const risks = validateClassRisks(raw['risks'], `${path}.risks`);
    return {
      id,
      kind: kind as NodeKind,
      range,
      intent,
      docComment: optionalString(raw, 'docComment'),
      confidence,
      risks,
      methodIds: methodIdsRaw as string[],
    };
  } catch (e) {
    errors.push({ reason: `${path}: ${(e as Error).message}`, raw: JSON.stringify(raw).slice(0, 200) });
    return undefined;
  }
}

function validateMethodFragment(
  raw: unknown,
  path: string,
  errors: ParseError[]
): LlmMethodNodeFragment | undefined {
  if (!isObject(raw)) {
    errors.push({ reason: `${path} is not an object`, raw: JSON.stringify(raw).slice(0, 200) });
    return undefined;
  }
  try {
    const visibilityRaw = raw['visibility'];
    let visibility: Visibility | undefined;
    if (visibilityRaw !== undefined && visibilityRaw !== null) {
      if (typeof visibilityRaw !== 'string' || !VALID_VISIBILITY.has(visibilityRaw as Visibility)) {
        throw new Error(`unknown visibility: ${String(visibilityRaw)}`);
      }
      visibility = visibilityRaw as Visibility;
    }
    const risks = validateMethodRisks(raw['risks'], `${path}.risks`);
    const isStaticRaw = raw['isStatic'];
    let isStatic: boolean | undefined;
    if (isStaticRaw !== undefined && isStaticRaw !== null) {
      if (typeof isStaticRaw !== 'boolean') throw new Error('isStatic is not a boolean');
      isStatic = isStaticRaw;
    }
    return {
      id: expectString(raw, 'id', path),
      ownerClassId: expectString(raw, 'ownerClassId', path),
      name: expectString(raw, 'name', path),
      signature: expectString(raw, 'signature', path),
      line: expectNumber(raw, 'line', path),
      visibility,
      isStatic,
      intent: optionalString(raw, 'intent'),
      docComment: optionalString(raw, 'docComment'),
      risks,
    };
  } catch (e) {
    errors.push({ reason: `${path}: ${(e as Error).message}`, raw: JSON.stringify(raw).slice(0, 200) });
    return undefined;
  }
}

function validateSummaryBlock(data: unknown, errors: ParseError[]): SummaryBlockPayload | undefined {
  if (!isObject(data)) {
    errors.push({ reason: 'summary block is not an object', raw: JSON.stringify(data).slice(0, 200) });
    return undefined;
  }
  return {
    rootIntent: optionalString(data, 'rootIntent'),
    narrative: optionalString(data, 'narrative'),
  };
}

function validateClassRisks(value: unknown, path: string): { type: RiskType; desc: string }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${path} is not an array`);
  const out: { type: RiskType; desc: string }[] = [];
  value.forEach((r, i) => {
    if (!isObject(r)) throw new Error(`${path}[${i}] is not an object`);
    const type = r['type'];
    const desc = r['desc'];
    if (typeof type !== 'string' || !VALID_RISK_TYPES.has(type as RiskType)) {
      throw new Error(`${path}[${i}].type: unknown risk type ${String(type)}`);
    }
    if (typeof desc !== 'string') throw new Error(`${path}[${i}].desc is not a string`);
    out.push({ type: type as RiskType, desc });
  });
  return out;
}

function validateMethodRisks(value: unknown, path: string): RiskType[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${path} is not an array`);
  return value.map((r, i) => {
    if (typeof r !== 'string' || !VALID_RISK_TYPES.has(r as RiskType)) {
      throw new Error(`${path}[${i}]: unknown risk type ${String(r)}`);
    }
    return r as RiskType;
  });
}

function expectString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== 'string') throw new Error(`${path}.${key} is not a string`);
  return v;
}

function expectNumber(obj: Record<string, unknown>, key: string, path: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${path}.${key} is not a finite number`);
  }
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return undefined;
  return v;
}

function enforceMethodOwnership(
  classes: ClassNode[],
  methods: MethodNode[],
  errors: ParseError[]
): void {
  const classIds = new Set(classes.map((c) => c.id));
  const methodIds = new Set(methods.map((m) => m.id));
  for (const m of methods) {
    if (!classIds.has(m.ownerClassId)) {
      errors.push({
        reason: `MethodNode ${m.id} references unknown ownerClassId ${m.ownerClassId}`,
        raw: m.id,
      });
    }
  }
  for (const c of classes) {
    for (const id of c.methodIds) {
      if (!methodIds.has(id)) {
        errors.push({
          reason: `ClassNode ${c.id} lists methodId ${id} with no matching MethodNode`,
          raw: id,
        });
      }
    }
  }
}

// -------------------------------------------------------------------------
//   shape lift
// -------------------------------------------------------------------------

function toClassNode(frag: LlmClassNodeFragment, filePath: string): ClassNode {
  return {
    id: frag.id,
    kind: frag.kind,
    boundedContext: '',
    file: filePath,
    range: frag.range,
    intent: frag.intent,
    docComment: frag.docComment,
    confidence: frag.confidence,
    risks: frag.risks,
    methodIds: frag.methodIds,
    verification: 'unverified',
  };
}

function toMethodNode(frag: LlmMethodNodeFragment): MethodNode {
  return {
    id: frag.id,
    ownerClassId: frag.ownerClassId,
    name: frag.name,
    signature: frag.signature,
    line: frag.line,
    visibility: frag.visibility,
    isStatic: frag.isStatic,
    intent: frag.intent,
    docComment: frag.docComment,
    risks: frag.risks,
    verification: 'unverified',
  };
}
