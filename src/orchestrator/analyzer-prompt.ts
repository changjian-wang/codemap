// Phase 3.1 -- analyzer prompt.
//
// Narrow contract: extract every top-level type declaration and its
// methods from a single source file, returning two fenced JSON blocks.
// Constructors are intentionally excluded (the v2 shape contract: they
// surface in the detail panel only, never as MethodNodes). Bounded-
// context classification and entry-point detection are NOT part of this
// prompt -- those belong to Phase 3.2.

import type { ClassNode, MethodNode } from '../shared/types';

export interface LlmClassNodeFragment {
  id: ClassNode['id'];
  kind: ClassNode['kind'];
  range: ClassNode['range'];
  intent: ClassNode['intent'];
  docComment?: ClassNode['docComment'];
  confidence: ClassNode['confidence'];
  risks: ClassNode['risks'];
  methodIds: ClassNode['methodIds'];
}

export interface LlmMethodNodeFragment {
  id: MethodNode['id'];
  ownerClassId: MethodNode['ownerClassId'];
  name: MethodNode['name'];
  signature: MethodNode['signature'];
  line: MethodNode['line'];
  visibility?: MethodNode['visibility'];
  isStatic?: MethodNode['isStatic'];
  intent?: MethodNode['intent'];
  docComment?: MethodNode['docComment'];
  risks: MethodNode['risks'];
}

export interface MetaBlockPayload {
  classes: LlmClassNodeFragment[];
  methods: LlmMethodNodeFragment[];
}

export interface SummaryBlockPayload {
  rootIntent?: string;
  narrative?: string;
}

export const SYSTEM_PROMPT = `You are CodeMap, a static code-architecture analyzer.

You receive ONE source file at a time. Identify every top-level type
declaration (class, interface, record, enum, struct) and its methods,
and return your analysis as exactly two fenced JSON blocks (no prose
outside the fences).

Block 1 -- \`\`\`codemap-meta\`\`\` with this shape:

{
  "classes": [
    {
      "id": "<bare type name, no namespace, no FQN>",
      "kind": "class" | "interface" | "record" | "enum" | "struct",
      "range": { "startLine": <1-based int>, "endLine": <1-based int> },
      "intent": "<one short sentence describing what this type does>",
      "docComment": "<optional, the doc summary verbatim if present>",
      "confidence": <float between 0 and 1>,
      "risks": [
        { "type": "security|external_io|concurrency|low_confidence|high_coupling|missing_test",
          "desc": "<short>" }
      ],
      "methodIds": ["<TypeName.MethodName>", ...]
    }
  ],
  "methods": [
    {
      "id": "<TypeName.MethodName -- must match an entry in some class.methodIds>",
      "ownerClassId": "<TypeName>",
      "name": "<bare method name, no parens>",
      "signature": "<display signature including parens, e.g. (Guid id, CancellationToken ct)>",
      "line": <1-based int -- where the method declaration starts>,
      "visibility": "public" | "private" | "protected" | "internal",
      "isStatic": <bool>,
      "intent": "<optional one-sentence summary>",
      "docComment": "<optional doc summary verbatim>",
      "risks": ["security", "external_io", ...]
    }
  ]
}

Block 2 -- \`\`\`codemap-summary\`\`\` with this shape (both fields optional):

{
  "rootIntent": "<one sentence: what does this file accomplish>",
  "narrative": "<2-3 sentences telling the reading order through the file>"
}

CRITICAL RULES:

1. Constructors are NEVER emitted as MethodNodes. Do not include them.
2. Overloaded methods collapse into ONE MethodNode (use the first signature you see).
3. Property accessors, indexers, and operator overloads are NOT MethodNodes.
4. Use bare type names (no namespaces, no generics in the id). For
   generic types use the base name without type parameters in id and
   methodIds.
5. Every entry in classes[].methodIds MUST have a matching object in
   methods[] (same id), and every methods[].ownerClassId MUST match an
   id in classes[].
6. \`line\` numbers are 1-based and refer to the line where the method
   declaration starts (the modifier or return-type keyword).
7. \`startLine\`/\`endLine\` for class range cover the entire type body
   including opening and closing brace.
8. Do NOT emit \`boundedContext\`, \`isEntry\`, \`entryKind\`, \`isShared\`,
   \`verification\`, \`readState\`, or \`file\` fields -- those are
   populated by downstream passes.
9. If the file contains no type declarations, emit an empty classes[]
   and methods[] -- do NOT skip the meta block.
10. NO prose outside the two fenced blocks. NO additional fences.`;

export function buildUserMessage(filePath: string, fileText: string): string {
  return [
    `File: ${filePath}`,
    '',
    '```source',
    fileText,
    '```',
  ].join('\n');
}
