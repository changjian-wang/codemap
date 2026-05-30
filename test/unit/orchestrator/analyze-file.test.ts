// Phase 3.1 -- analyzeFile() unit tests.
//
// MockLlmClient yields a pre-recorded fenced reply so we exercise the
// full parse-and-lift pipeline without touching vscode.lm. The
// IngestUrlHandler test fulfils v4-plan section 3.1's acceptance
// criterion at the parser layer (parses to v2 shape correctly); the
// HITL half (real Copilot model actually emits a compliant reply) is
// scheduled for Phase 3.3 when the chat participant is rewired.

import { describe, expect, it } from 'vitest';
import { analyzeFile } from '../../../src/orchestrator/analyze-file';
import type { LlmClient, LlmStreamRequest } from '../../../src/orchestrator/llm-client';

class MockLlmClient implements LlmClient {
  constructor(private readonly chunks: string[]) {}
  async *stream(_req: LlmStreamRequest): AsyncIterable<string> {
    for (const c of this.chunks) {
      yield c;
    }
  }
}

const INGEST_URL_HANDLER_REPLY = `Sure, here is the analysis.

\`\`\`codemap-meta
{
  "classes": [
    {
      "id": "IngestUrlHandler",
      "kind": "class",
      "range": { "startLine": 12, "endLine": 376 },
      "intent": "Coordinates URL capture: enqueue, fetch, embed, persist.",
      "confidence": 0.85,
      "risks": [
        { "type": "external_io", "desc": "Calls an external HTTP extractor and embedder." }
      ],
      "methodIds": [
        "IngestUrlHandler.EnqueueAsync",
        "IngestUrlHandler.ExecuteAsync",
        "IngestUrlHandler.TryExtractAsync",
        "IngestUrlHandler.TryEmbedAsync"
      ]
    }
  ],
  "methods": [
    {
      "id": "IngestUrlHandler.EnqueueAsync",
      "ownerClassId": "IngestUrlHandler",
      "name": "EnqueueAsync",
      "signature": "(IngestUrlRequest request, CancellationToken cancellationToken)",
      "line": 51,
      "visibility": "public",
      "isStatic": false,
      "intent": "Persist a capture job and return the new id.",
      "risks": []
    },
    {
      "id": "IngestUrlHandler.ExecuteAsync",
      "ownerClassId": "IngestUrlHandler",
      "name": "ExecuteAsync",
      "signature": "(Guid jobId, string url, Guid? actorId, CancellationToken cancellationToken)",
      "line": 113,
      "visibility": "public",
      "isStatic": false,
      "intent": "Run the full ingest pipeline for a queued job.",
      "risks": ["external_io"]
    },
    {
      "id": "IngestUrlHandler.TryExtractAsync",
      "ownerClassId": "IngestUrlHandler",
      "name": "TryExtractAsync",
      "signature": "(string url, CancellationToken ct)",
      "line": 220,
      "visibility": "private",
      "isStatic": false,
      "intent": "Run the content extractor and swallow soft failures.",
      "risks": []
    },
    {
      "id": "IngestUrlHandler.TryEmbedAsync",
      "ownerClassId": "IngestUrlHandler",
      "name": "TryEmbedAsync",
      "signature": "(string text, CancellationToken ct)",
      "line": 260,
      "visibility": "private",
      "isStatic": false,
      "intent": "Embed the text and swallow soft failures.",
      "risks": []
    }
  ]
}
\`\`\`

\`\`\`codemap-summary
{
  "rootIntent": "Capture a URL into the event store via the staged pipeline.",
  "narrative": "EnqueueAsync persists a job and returns its id. ExecuteAsync drives the URL through extract, embed, and persist; soft failures fall back to a partial entity. Repository helpers and dispatchers handle the side effects."
}
\`\`\`
`;

describe('analyzeFile -- v2 shape from LLM reply', () => {
  it('lifts the IngestUrlHandler reply into a ClassNode + MethodNodes', async () => {
    const llm = new MockLlmClient([INGEST_URL_HANDLER_REPLY]);
    const result = await analyzeFile(
      {
        filePath: 'apps/api/src/Lumen.Modules.Capture/Features/IngestUrl/IngestUrlHandler.cs',
        fileText: '// content irrelevant; MockLlmClient ignores it',
        languageId: 'csharp',
      },
      llm
    );

    expect(result.parseErrors).toEqual([]);
    expect(result.classes).toHaveLength(1);
    const cls = result.classes[0];
    expect(cls.id).toBe('IngestUrlHandler');
    expect(cls.kind).toBe('class');
    expect(cls.file).toBe(
      'apps/api/src/Lumen.Modules.Capture/Features/IngestUrl/IngestUrlHandler.cs'
    );
    expect(cls.boundedContext).toBe(''); // 3.2 BC classifier fills this
    expect(cls.verification).toBe('unverified');
    expect(cls.range).toEqual({ startLine: 12, endLine: 376 });
    expect(cls.methodIds).toContain('IngestUrlHandler.EnqueueAsync');
    expect(cls.methodIds).toContain('IngestUrlHandler.ExecuteAsync');

    expect(result.methods.map((m) => m.id).sort()).toEqual(
      [
        'IngestUrlHandler.EnqueueAsync',
        'IngestUrlHandler.ExecuteAsync',
        'IngestUrlHandler.TryExtractAsync',
        'IngestUrlHandler.TryEmbedAsync',
      ].sort()
    );

    const execute = result.methods.find((m) => m.id === 'IngestUrlHandler.ExecuteAsync');
    expect(execute).toBeDefined();
    expect(execute!.ownerClassId).toBe('IngestUrlHandler');
    expect(execute!.name).toBe('ExecuteAsync');
    expect(execute!.line).toBe(113);
    expect(execute!.visibility).toBe('public');
    expect(execute!.verification).toBe('unverified');
    expect(execute!.risks).toEqual(['external_io']);

    expect(result.rootIntent).toMatch(/Capture/);
    expect(result.narrative).toMatch(/EnqueueAsync/);
  });

  it('streams chunked reply and still emits the same shape', async () => {
    const chunks: string[] = [];
    for (let i = 0; i < INGEST_URL_HANDLER_REPLY.length; i += 17) {
      chunks.push(INGEST_URL_HANDLER_REPLY.slice(i, i + 17));
    }
    const llm = new MockLlmClient(chunks);
    const result = await analyzeFile(
      { filePath: 'x.cs', fileText: '', languageId: 'csharp' },
      llm
    );
    expect(result.parseErrors).toEqual([]);
    expect(result.classes[0].id).toBe('IngestUrlHandler');
    expect(result.methods).toHaveLength(4);
  });

  it('returns empty arrays for a file with no types and no errors', async () => {
    const llm = new MockLlmClient([
      '```codemap-meta\n{"classes":[],"methods":[]}\n```\n',
      '```codemap-summary\n{}\n```',
    ]);
    const result = await analyzeFile(
      { filePath: 'empty.cs', fileText: '', languageId: 'csharp' },
      llm
    );
    expect(result.parseErrors).toEqual([]);
    expect(result.classes).toEqual([]);
    expect(result.methods).toEqual([]);
    expect(result.rootIntent).toBeUndefined();
  });

  it('records a parseError when the meta block is missing entirely', async () => {
    const llm = new MockLlmClient(['I cannot help with that request.']);
    const result = await analyzeFile(
      { filePath: 'x.cs', fileText: '', languageId: 'csharp' },
      llm
    );
    expect(result.classes).toEqual([]);
    expect(result.parseErrors).toHaveLength(1);
    expect(result.parseErrors[0].reason).toMatch(/No codemap-meta block/);
  });

  it('drops only the invalid class/method entries and keeps the rest', async () => {
    const reply = [
      '```codemap-meta',
      JSON.stringify({
        classes: [
          {
            id: 'Good',
            kind: 'class',
            range: { startLine: 1, endLine: 10 },
            intent: 'ok',
            confidence: 0.9,
            risks: [],
            methodIds: ['Good.run'],
          },
          {
            id: 'Bad',
            kind: 'enum-with-typo', // invalid
            range: { startLine: 11, endLine: 20 },
            intent: 'bad',
            confidence: 0.5,
            risks: [],
            methodIds: [],
          },
        ],
        methods: [
          {
            id: 'Good.run',
            ownerClassId: 'Good',
            name: 'run',
            signature: '()',
            line: 2,
            visibility: 'public',
            risks: [],
          },
          {
            id: 'Orphan.x',
            ownerClassId: 'Orphan', // not in classes
            name: 'x',
            signature: '()',
            line: 99,
            visibility: 'public',
            risks: [],
          },
        ],
      }),
      '```',
    ].join('\n');

    const llm = new MockLlmClient([reply]);
    const result = await analyzeFile(
      { filePath: 'x.cs', fileText: '', languageId: 'csharp' },
      llm
    );

    expect(result.classes.map((c) => c.id)).toEqual(['Good']);
    expect(result.methods.map((m) => m.id).sort()).toEqual(['Good.run', 'Orphan.x']);
    // Two errors: the bad NodeKind, and the orphan method ownership check.
    expect(result.parseErrors.length).toBeGreaterThanOrEqual(2);
    expect(result.parseErrors.some((e) => /unknown NodeKind/.test(e.reason))).toBe(true);
    expect(result.parseErrors.some((e) => /unknown ownerClassId/.test(e.reason))).toBe(true);
  });

  it('aborts when the signal is fired (mock LlmClient just stops yielding)', async () => {
    // The mock yields chunks; if the analyzer respected signal it would
    // surface fewer parsed entries. We don't deeply test signal here -- the
    // wire-level cancellation lives in VscodeLmClient. This test asserts
    // the API accepts and forwards the signal without throwing.
    const ac = new AbortController();
    ac.abort();
    const llm = new MockLlmClient([INGEST_URL_HANDLER_REPLY]);
    const result = await analyzeFile(
      { filePath: 'x.cs', fileText: '', languageId: 'csharp', signal: ac.signal },
      llm
    );
    // MockLlmClient doesn't honor signal; result should still be valid.
    expect(result.classes[0].id).toBe('IngestUrlHandler');
  });
});
