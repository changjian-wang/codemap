import type { CodeMapGraph } from '../shared/types';

/**
 * W1 fixture. Mirrors a slimmed-down version of the lumen-backend-v3 mockup
 * data so the WebView has something to render before the orchestrator lands.
 *
 * The mockup HTML carries its own inline copy of this data for now; once the
 * React port replaces the mockup in W2-W3, this fixture becomes the single
 * source of truth fed via postMessage.
 */
export const DEMO_GRAPH: CodeMapGraph = {
  rootRequest: '@codemap demo (fixture)',
  scope: 'workspace',
  nodes: {
    Program: {
      id: 'Program',
      kind: 'class',
      file: 'apps/api/src/Lumen.Host/Program.cs',
      range: { startLine: 1, endLine: 120 },
      boundedContext: 'host',
      intent: 'WebApplication 启动入口',
      layer: 'entry',
      confidence: 0.95,
      risks: [],
      methods: [
        { name: 'Main', signature: '(string[] args)', line: 14, risks: [] },
      ],
      readingPriority: 1,
      readState: 'read',
      verification: 'verified',
    },
    IngestUrlHandler: {
      id: 'IngestUrlHandler',
      kind: 'class',
      file: 'apps/api/src/Lumen.Modules.Capture/Features/IngestUrl/IngestUrlHandler.cs',
      range: { startLine: 13, endLine: 240 },
      boundedContext: 'capture',
      intent: 'URL canonicalize → 去重 → 写 capture_jobs → worker 异步执行',
      layer: 'service',
      confidence: 0.9,
      risks: [
        { type: 'concurrency', desc: 'UNIQUE 索引兜底并发 INSERT' },
        { type: 'external_io', desc: '抓取远端 URL' },
      ],
      methods: [
        { name: 'EnqueueAsync', signature: '(req, ct)', line: 49, risks: ['concurrency'] },
        { name: 'ExecuteAsync', signature: '(jobId, ct)', line: 112, risks: ['external_io'] },
      ],
      readingPriority: 3,
      readState: 'unread',
      verification: 'verified',
    },
  },
  edges: [
    { from: 'Program', to: 'IngestUrlHandler', kind: 'calls', verified: true },
  ],
  externalDeps: [
    { name: 'Dawning.ORM.Dapper', kind: 'package' },
  ],
  rootIntent: 'Demo fixture — 见 docs/mockups/lumen-backend-v3.html 看完整版',
  narrative: 'This is a W1 fixture. The real graph is produced by the orchestrator in W2-W3.',
  suggestedEntryNodes: ['Program'],
  readingOrder: ['Program', 'IngestUrlHandler'],
};
