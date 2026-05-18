import type { CodeMapGraph } from '../shared/types';
import type { MockupChatTurn } from './graph-adapter';

/**
 * Full lumen-backend fixture, mirroring docs/mockups/lumen-backend-v3.html.
 * This is the canonical demo graph for W1; W2-W3's orchestrator output
 * replaces it without any UI change.
 */
export const DEMO_GRAPH: CodeMapGraph = {
  rootRequest: '@codemap demo (lumen backend fixture)',
  scope: 'workspace',
  rootIntent: 'Lumen .NET 8 modular monolith — Capture/Recall/Memory/Connect/...',
  narrative:
    'Built-in demo. Replace via the orchestrator (W2-W3) for real workspace analysis.',
  suggestedEntryNodes: ['Program'],
  nodes: {
    Program: {
      id: 'Program', kind: 'class',
      file: 'apps/api/src/Lumen.Host/Program.cs',
      range: { startLine: 1, endLine: 120 },
      boundedContext: 'host', layer: 'entry',
      verification: 'verified', readingPriority: 1,
      confidence: 0.95, readState: 'read',
      intent: 'WebApplication 启动：注册 modules（Capture/Recall/Memory/...）、配置 Postgres + pgvector、挂载 endpoints',
      risks: [],
      methods: [
        { name: 'Main', signature: '(string[] args)', line: 14, risks: [], readState: 'read' },
        { name: 'ConfigureModules', signature: '(builder)', line: 47, risks: [], readState: 'read' },
        { name: 'MapAllModuleEndpoints', signature: '(app)', line: 89, risks: [], readState: 'read' },
      ],
    },

    CaptureEndpoints: {
      id: 'CaptureEndpoints', kind: 'class',
      file: 'apps/api/src/Lumen.Modules.Capture/Endpoints/CaptureEndpoints.cs',
      range: { startLine: 1, endLine: 80 },
      boundedContext: 'capture', layer: 'controller',
      verification: 'verified', readingPriority: 2,
      confidence: 0.96, readState: 'read',
      intent: 'Minimal API 路由组 /api/captures：POST /url 异步入队、GET / 列表、GET /jobs/{id}',
      risks: [{ type: 'external_io', desc: 'HTTP entry — 接收用户上传 URL' }],
      methods: [
        { name: 'MapCaptureEndpoints', signature: '(this app)', line: 14, risks: [], readState: 'read' },
        { name: 'IngestUrl', signature: '(req, handler, ct)', line: 28, risks: ['external_io'], readState: 'read' },
        { name: 'List', signature: '(req, handler, ct)', line: 43, risks: [] },
        { name: 'GetJob', signature: '(jobId, handler, ct)', line: 52, risks: [] },
      ],
    },

    IngestUrlHandler: {
      id: 'IngestUrlHandler', kind: 'class',
      file: 'apps/api/src/Lumen.Modules.Capture/Features/IngestUrl/IngestUrlHandler.cs',
      range: { startLine: 13, endLine: 240 },
      boundedContext: 'capture', layer: 'service',
      verification: 'verified', readingPriority: 3,
      confidence: 0.9, readState: 'read',
      intent: 'ADR-028/029：URL canonicalize → 去重 in-flight → 写 capture_jobs (pending) → worker 异步执行 extract+embed+chunk',
      risks: [
        { type: 'concurrency', desc: 'UNIQUE 索引并发 insert + 23505 重试' },
        { type: 'external_io', desc: '抓取远端 URL（HtmlContentExtractor）' },
      ],
      methods: [
        { name: 'EnqueueAsync', signature: '(IngestUrlRequest, ct)', line: 49, risks: ['concurrency', 'external_io'], readState: 'read' },
        { name: 'ExecuteAsync', signature: '(Guid jobId, ct)', line: 112, risks: ['external_io', 'concurrency'] },
      ],
    },

    CaptureJobWorker: {
      id: 'CaptureJobWorker', kind: 'class',
      file: 'apps/api/src/Lumen.Modules.Capture/Workers/CaptureJobWorker.cs',
      range: { startLine: 1, endLine: 200 },
      boundedContext: 'capture', layer: 'service',
      verification: 'verified', readingPriority: 4,
      confidence: 0.88, readState: 'unread',
      intent: 'BackgroundService：串行 drain capture_jobs。崩溃恢复 (ResetStuckProcessing) + 重试退避 + 取消语义',
      risks: [{ type: 'concurrency', desc: 'BackgroundService + DI scope per tick' }],
      methods: [
        { name: 'StartAsync', signature: '(ct)', line: 49, risks: ['concurrency'] },
        { name: 'ExecuteAsync', signature: '(stoppingCt)', line: 87, risks: ['concurrency'] },
        { name: 'TickOnceAsync', signature: '(ct)', line: 132, risks: ['concurrency'] },
      ],
    },

    EventStore: {
      id: 'EventStore', kind: 'class',
      file: 'apps/api/src/Lumen.Modules.Capture/Persistence/EventStore.cs',
      range: { startLine: 1, endLine: 60 },
      boundedContext: 'capture', layer: 'repo',
      verification: 'verified', readingPriority: 5,
      confidence: 0.97, readState: 'unread',
      intent: 'Dapper-based store for EventEntity（含 pgvector 列）。Insert 与按 Id 查询',
      risks: [],
      methods: [
        { name: 'InsertAsync', signature: '(EventEntity, ct)', line: 24, risks: [] },
        { name: 'GetByIdAsync', signature: '(Guid id, ct)', line: 30, risks: [] },
      ],
    },

    EventChunkStore: {
      id: 'EventChunkStore', kind: 'class',
      file: 'apps/api/src/Lumen.Modules.Capture/Persistence/EventChunkStore.cs',
      range: { startLine: 1, endLine: 40 },
      boundedContext: 'capture', layer: 'repo',
      verification: 'verified', readingPriority: 6,
      confidence: 0.96, readState: 'unread',
      intent: 'ADR-022 §C：批量 insert event chunks (≤ 32/event)，每行单独 INSERT',
      risks: [],
      methods: [
        { name: 'InsertRangeAsync', signature: '(chunks, ct)', line: 18, risks: [] },
      ],
    },

    CaptureJobStore: {
      id: 'CaptureJobStore', kind: 'class',
      file: 'apps/api/src/Lumen.Modules.Capture/Persistence/CaptureJobStore.cs',
      range: { startLine: 1, endLine: 210 },
      boundedContext: 'capture', layer: 'repo',
      verification: 'verified', readingPriority: 7,
      confidence: 0.93, readState: 'unread',
      intent: 'capture_jobs 表的 Dapper 仓储：claim/insert/mark/reset stuck/find in-flight',
      risks: [{ type: 'concurrency', desc: '依赖部分 UNIQUE 索引兜底并发' }],
      methods: [
        { name: 'InsertAsync', signature: '(...)', line: 22, risks: ['concurrency'] },
        { name: 'FindInFlightByCanonicalUrlAsync', signature: '(url, actor, ct)', line: 51, risks: [] },
        { name: 'ClaimNextPendingAsync', signature: '(now, ct)', line: 78, risks: ['concurrency'] },
        { name: 'MarkSucceededAsync', signature: '(jobId, ct)', line: 112, risks: [] },
        { name: 'RescheduleAsync', signature: '(jobId, until, ct)', line: 141, risks: [] },
        { name: 'MarkFailedAsync', signature: '(jobId, reason, ct)', line: 168, risks: [] },
        { name: 'ResetStuckProcessingAsync', signature: '(now, ct)', line: 193, risks: [] },
      ],
    },

    RecallEndpoints: {
      id: 'RecallEndpoints', kind: 'class',
      file: 'apps/api/src/Lumen.Modules.Recall/Endpoints/RecallEndpoints.cs',
      range: { startLine: 1, endLine: 60 },
      boundedContext: 'recall', layer: 'controller',
      verification: 'verified', readingPriority: 8,
      confidence: 0.96, readState: 'unread',
      intent: 'Minimal API 路由组 /api/recall：GET / 向量召回、POST /ask grounded LLM 问答',
      risks: [{ type: 'security', desc: 'Prompt injection 风险：自然语言 query' }],
      methods: [
        { name: 'MapRecallEndpoints', signature: '(this app)', line: 14, risks: [] },
        { name: 'Search', signature: '(req, handler, ct)', line: 28, risks: [] },
        { name: 'Ask', signature: '(req, handler, ct)', line: 38, risks: ['security'] },
      ],
    },

    RecallByQueryHandler: {
      id: 'RecallByQueryHandler', kind: 'class',
      file: 'apps/api/src/Lumen.Modules.Recall/Features/RecallByQuery/RecallByQueryHandler.cs',
      range: { startLine: 1, endLine: 50 },
      boundedContext: 'recall', layer: 'service',
      verification: 'verified', readingPriority: 9,
      confidence: 0.94, readState: 'unread',
      intent: 'query → embed → IRecallQuery.SearchAsync（pgvector cosine top-K）→ 反序列化 payload',
      risks: [],
      methods: [
        { name: 'HandleAsync', signature: '(req, ct)', line: 14, risks: [] },
        { name: 'ParsePayload', signature: '(raw)', line: 41, risks: [] },
      ],
    },

    AskByQueryHandler: {
      id: 'AskByQueryHandler', kind: 'class',
      file: 'apps/api/src/Lumen.Modules.Recall/Features/AskByQuery/AskByQueryHandler.cs',
      range: { startLine: 1, endLine: 130 },
      boundedContext: 'recall', layer: 'service',
      verification: 'partial', readingPriority: 10,
      confidence: 0.81, readState: 'unread',
      intent: 'ADR-017 grounded ask：embed → top-K cosine → 组装 GroundedAskPrompts → ILlmService → 解析 [n] 强引用',
      risks: [
        { type: 'security', desc: 'Prompt injection 重灾区' },
        { type: 'low_confidence', desc: 'fail-soft 路径未被 golden 完全覆盖' },
      ],
      methods: [
        { name: 'HandleAsync', signature: '(req, ct)', line: 33, risks: ['security', 'low_confidence'] },
        { name: 'ExtractReferencedIndices', signature: '(answer)', line: 110, risks: [] },
      ],
      verificationDetails: {
        rangeAdjusted: false,
        droppedCalls: ['GroundedAskPromptsV2.BuildUserPrompt'],
        droppedExternalCalls: [],
      },
    },

    RecallQuery: {
      id: 'RecallQuery', kind: 'class',
      file: 'apps/api/src/Lumen.Modules.Recall/Persistence/RecallQuery.cs',
      range: { startLine: 1, endLine: 40 },
      boundedContext: 'recall', layer: 'repo',
      verification: 'verified', readingPriority: 11,
      confidence: 0.92, readState: 'unread',
      intent: '原生 SQL：pgvector cosine（<=> 操作符）做 top-K 搜索，按 topic 分区',
      risks: [{ type: 'external_io', desc: 'pgvector 索引未命中时全表扫描' }],
      methods: [
        { name: 'SearchAsync', signature: '(Vector q, topic, k, ct)', line: 18, risks: ['external_io'] },
      ],
    },

    OnnxEmbeddingService: {
      id: 'OnnxEmbeddingService', kind: 'class',
      file: 'apps/api/src/Lumen.Shared.Infrastructure/Embeddings/OnnxEmbeddingService.cs',
      range: { startLine: 1, endLine: 200 },
      boundedContext: 'shared', layer: 'util',
      verification: 'verified', readingPriority: 12,
      confidence: 0.93, readState: 'unread',
      intent: 'In-process ONNX：tokenize → inference → masked mean pool → L2 normalize。多线程读路径安全',
      risks: [{ type: 'concurrency', desc: 'singleton + ORT InferenceSession 并发推理' }],
      methods: [
        { name: 'EmbedQueryAsync', signature: '(text, ct)', line: 44, risks: ['concurrency'] },
        { name: 'EmbedDocumentAsync', signature: '(text, ct)', line: 55, risks: ['concurrency'] },
        { name: 'EmbedSync', signature: '(prefixedText)', line: 78, risks: [] },
        { name: 'ApplyPrefix', signature: '(text, isQuery)', line: 134, risks: [] },
      ],
    },

    OllamaLlmService: {
      id: 'OllamaLlmService', kind: 'class',
      file: 'apps/api/src/Lumen.Shared.Infrastructure/Llm/OllamaLlmService.cs',
      range: { startLine: 1, endLine: 170 },
      boundedContext: 'shared', layer: 'util',
      verification: 'partial', readingPriority: 13,
      confidence: 0.84, readState: 'unread',
      intent: 'ADR-017：HTTP POST Ollama /api/chat（non-streaming），剥离 <think> 块到 ReasoningTrace',
      risks: [{ type: 'external_io', desc: 'Ollama sidecar HTTP，超时/503 需重试' }],
      methods: [
        { name: 'ChatAsync', signature: '(messages, opts, ct)', line: 48, risks: ['external_io'] },
        { name: 'StripThinkBlock', signature: '(rawAnswer)', line: 121, risks: [] },
        { name: 'MapOllamaResponse', signature: '(json)', line: 156, risks: [] },
      ],
      verificationDetails: {
        rangeAdjusted: true,
        droppedCalls: [],
        droppedExternalCalls: ['OllamaSharp.IOllamaApiClient'],
      },
    },

    HtmlContentExtractor: {
      id: 'HtmlContentExtractor', kind: 'class',
      file: 'apps/api/src/Lumen.Shared.Infrastructure/Extraction/HtmlContentExtractor.cs',
      range: { startLine: 1, endLine: 200 },
      boundedContext: 'shared', layer: 'util',
      verification: 'verified', readingPriority: 14,
      confidence: 0.91, readState: 'unread',
      intent: 'HttpClient 抓 → SmartReader Readability → ReverseMarkdown。带 SSRF 防护（拒绝 RFC1918/loopback 等）',
      risks: [{ type: 'security', desc: 'SSRF 边界（OWASP A10:2021）' }],
      methods: [
        { name: 'ExtractAsync', signature: '(url, ct)', line: 43, risks: ['security', 'external_io'] },
        { name: 'AssertHostIsPublicAsync', signature: '(host, ct)', line: 102, risks: ['security'] },
        { name: 'BuildExtractorId', signature: '(primary)', line: 178, risks: [] },
      ],
    },

    GroundedAskPromptsV2: {
      id: 'GroundedAskPromptsV2', kind: 'class',
      file: '(unresolved: GroundedAskPromptsV2 not found in workspace)',
      range: { startLine: 0, endLine: 0 },
      boundedContext: 'recall', layer: 'util',
      verification: 'unverified', readingPriority: 99,
      confidence: 0.38, readState: 'unread',
      intent: 'LLM 在 AskByQueryHandler 的 calls 中提到该类，但 executeWorkspaceSymbolProvider 未找到',
      risks: [{ type: 'low_confidence', desc: 'LLM 可能幻觉，已标灰禁用跳转' }],
      methods: [
        { name: 'BuildUserPrompt', signature: '(q, snippets)', line: 0, risks: ['low_confidence'] },
      ],
      verificationDetails: {
        rangeAdjusted: false,
        droppedCalls: [],
        droppedExternalCalls: [],
        reason: 'executeWorkspaceSymbolProvider 未返回结果；可能 LLM 把 V1 + ADR-017 演进描述合成了一个虚类',
      },
    },
  },
  edges: [
    { from: 'Program', to: 'CaptureEndpoints', kind: 'calls', verified: true },
    { from: 'Program', to: 'RecallEndpoints', kind: 'calls', verified: true },

    { from: 'CaptureEndpoints', to: 'IngestUrlHandler', kind: 'calls', verified: true },
    { from: 'IngestUrlHandler', to: 'CaptureJobStore', kind: 'calls', verified: true },
    { from: 'CaptureJobWorker', to: 'CaptureJobStore', kind: 'calls', verified: true },
    { from: 'CaptureJobWorker', to: 'IngestUrlHandler', kind: 'calls', verified: true },
    { from: 'IngestUrlHandler', to: 'HtmlContentExtractor', kind: 'calls', verified: true },
    { from: 'IngestUrlHandler', to: 'OnnxEmbeddingService', kind: 'calls', verified: true },
    { from: 'IngestUrlHandler', to: 'EventStore', kind: 'calls', verified: true },
    { from: 'IngestUrlHandler', to: 'EventChunkStore', kind: 'calls', verified: true },

    { from: 'RecallEndpoints', to: 'RecallByQueryHandler', kind: 'calls', verified: true },
    { from: 'RecallEndpoints', to: 'AskByQueryHandler', kind: 'calls', verified: true },
    { from: 'RecallByQueryHandler', to: 'OnnxEmbeddingService', kind: 'calls', verified: true },
    { from: 'RecallByQueryHandler', to: 'RecallQuery', kind: 'calls', verified: true },
    { from: 'AskByQueryHandler', to: 'OnnxEmbeddingService', kind: 'calls', verified: true },
    { from: 'AskByQueryHandler', to: 'RecallQuery', kind: 'calls', verified: true },
    { from: 'AskByQueryHandler', to: 'OllamaLlmService', kind: 'calls', verified: true },

    { from: 'AskByQueryHandler', to: 'GroundedAskPromptsV2', kind: 'calls', verified: false },

    { from: 'EventStore', to: 'ext:Dawning.ORM.Dapper', kind: 'external_calls', verified: true },
    { from: 'EventChunkStore', to: 'ext:Dawning.ORM.Dapper', kind: 'external_calls', verified: true },
    { from: 'CaptureJobStore', to: 'ext:Dawning.ORM.Dapper', kind: 'external_calls', verified: true },
    { from: 'RecallQuery', to: 'ext:Pgvector', kind: 'external_calls', verified: true },
    { from: 'EventStore', to: 'ext:Npgsql.EntityFrameworkCore.PostgreSQL', kind: 'external_calls', verified: true },
    { from: 'OnnxEmbeddingService', to: 'ext:Microsoft.ML.OnnxRuntime', kind: 'external_calls', verified: true },
    { from: 'OnnxEmbeddingService', to: 'ext:Microsoft.ML.Tokenizers', kind: 'external_calls', verified: true },
    { from: 'HtmlContentExtractor', to: 'ext:SmartReader', kind: 'external_calls', verified: true },
    { from: 'HtmlContentExtractor', to: 'ext:ReverseMarkdown', kind: 'external_calls', verified: true },
  ],
  externalDeps: [
    { name: 'Dawning.ORM.Dapper', kind: 'package' },
    { name: 'Npgsql.EntityFrameworkCore.PostgreSQL', kind: 'package' },
    { name: 'Pgvector', kind: 'package' },
    { name: 'Microsoft.ML.OnnxRuntime', kind: 'package' },
    { name: 'Microsoft.ML.Tokenizers', kind: 'package' },
    { name: 'SmartReader', kind: 'package' },
    { name: 'ReverseMarkdown', kind: 'package' },
  ],
};

export const DEMO_CHAT_TURNS: MockupChatTurn[] = [
  {
    role: 'user', name: 'You', time: '14:02',
    content: '帮我生成 <span class="ref-chip">lumen</span> 后端 (apps/api) 的 codemap',
  },
  {
    role: 'assistant', name: '@codemap', time: '14:02',
    content:
      '好的，扫描 <span class="ref-chip">apps/api/src</span>。检测到这是 .NET 8 模块化单体，按 <code>Lumen.Modules.*</code> + <code>Lumen.Shared.*</code> 拆分。我会按 module 分批分析。',
    actions: [
      { check: true, num: '1', text: 'Scan: 173 .cs files, 8.8k LOC, 9 csproj projects' },
      { check: true, num: '2', text: 'Detect bounded contexts: Host, Modules.{Capture,Recall,Memory,Connect,...}, Shared' },
      { check: true, num: '3', text: 'Pick skeleton: 14 classes (Endpoints + Handlers + Stores + 3 Shared utils)' },
      { check: true, num: '4', text: 'Run 14 parallel analyzers (claude-3.5-sonnet)' },
      { check: true, num: '5', text: 'Cross-project edge resolution: 26 edges via LSP (10 external_calls)' },
      { check: true, num: '6', text: 'Calibration: 11 verified / 2 partial / 1 unverified' },
    ],
  },
  {
    role: 'assistant', name: '@codemap', time: '14:03',
    content:
      '分析完成。共 <code>14</code> 个类、<code>26</code> 条调用边。主管道：<span class="ref-chip">CaptureEndpoints</span> → <span class="ref-chip">IngestUrlHandler</span> → <span class="ref-chip">CaptureJobWorker</span>。Recall 侧两个端点。Eval：节点 P=0.93/R=0.86，边 P=0.84/R=0.77。',
  },
  {
    role: 'user', name: 'You', time: '14:04',
    content: '为什么 <span class="ref-chip">AskByQueryHandler</span> 是 partial？',
  },
  {
    role: 'assistant', name: '@codemap', time: '14:04',
    content:
      'LLM 在它的 <code>calls</code> 字段里列了 <code>GroundedAskPromptsV2.BuildUserPrompt</code>，但 calibrator 用 <code>executeWorkspaceSymbolProvider</code> 在工作区只找到 <code>GroundedAskPrompts</code>。保留节点但把这条边标为 unverified 灰线，禁用跳转。',
  },
];
