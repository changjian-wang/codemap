import { describe, it, expect } from 'vitest';
import { Calibrator } from '../../src/calibration/calibrator';
import type { SymbolProvider, SymbolHit } from '../../src/calibration/symbol-provider';

function makeProvider(args: {
  inFile?: Record<string, SymbolHit[] | undefined>;
  workspace?: Record<string, SymbolHit[]>;
  defaultInFile?: SymbolHit[] | undefined;
}): SymbolProvider {
  return {
    async symbolsInFile(file) {
      if (args.inFile && file in args.inFile) return args.inFile[file];
      return args.defaultInFile ?? [];
    },
    async findInWorkspace(name) {
      return args.workspace?.[name] ?? [];
    },
  };
}

const sym = (
  name: string,
  file: string,
  startLine: number,
  endLine: number,
): SymbolHit => ({ name, file, startLine, endLine });

describe('Calibrator', () => {
  it('returns undefined for malformed input (no node_id)', async () => {
    const c = new Calibrator(makeProvider({}));
    expect(await c.calibrate({ data: {}, file: 'x.cs', boundedContext: 'shared' })).toBeUndefined();
  });

  it('marks a class unverified when the file has no matching symbol', async () => {
    const c = new Calibrator(makeProvider({ inFile: { 'a.cs': [] } }));
    const out = await c.calibrate({
      data: { node_id: 'Ghost', intent: 'x' },
      file: 'a.cs',
      boundedContext: 'capture',
    });
    expect(out?.node.verification).toBe('unverified');
  });

  it('rewrites LLM-supplied range with LSP range and flags rangeAdjusted', async () => {
    const c = new Calibrator(
      makeProvider({ inFile: { 'a.cs': [sym('Foo', 'a.cs', 10, 50)] } }),
    );
    const out = await c.calibrate({
      data: { node_id: 'Foo', range: { startLine: 1, endLine: 100 } },
      file: 'a.cs',
      boundedContext: 'capture',
    });
    expect(out?.node.range).toEqual({ startLine: 10, endLine: 50 });
    expect(out?.node.verificationDetails?.rangeAdjusted).toBe(true);
    expect(out?.node.verification).toBe('verified');
  });

  it('does not flag rangeAdjusted when LLM range already matches LSP', async () => {
    const c = new Calibrator(
      makeProvider({ inFile: { 'a.cs': [sym('Foo', 'a.cs', 10, 50)] } }),
    );
    const out = await c.calibrate({
      data: { node_id: 'Foo', range: { startLine: 10, endLine: 50 } },
      file: 'a.cs',
      boundedContext: 'capture',
    });
    expect(out?.node.verificationDetails?.rangeAdjusted).toBe(false);
  });

  it('emits cross-file calls as verified=false edges (aggregator resolves them later)', async () => {
    // Cross-file calls are no longer dropped at the calibrator layer — the
    // aggregator does workspace symbol lookup and either promotes the edge to
    // verified or leaves it unverified and downgrades the source to partial.
    const c = new Calibrator(
      makeProvider({
        inFile: {
          'a.cs': [sym('Foo', 'a.cs', 1, 10), sym('Bar', 'a.cs', 12, 20)],
        },
      }),
    );
    const out = await c.calibrate({
      data: { node_id: 'Foo', calls: ['Bar', 'CrossFileClass'] },
      file: 'a.cs',
      boundedContext: 'capture',
    });
    expect(out?.node.verification).toBe('verified');          // calibrator doesn't downgrade
    expect(out?.node.verificationDetails?.droppedCalls).toEqual([]);
    const edges = out!.edges;
    expect(edges.find(e => e.to === 'Bar')?.verified).toBe(true);
    expect(edges.find(e => e.to === 'CrossFileClass')?.verified).toBe(false);
  });

  it('ignores nested symbols when validating calls targets', async () => {
    // The LSP returns a flat list that includes nested types via
    // DocumentSymbol.children — e.g. a private record `ChunkHit` declared
    // inside `RecallQuery.cs`. The v3 prompt has the LLM emit only
    // top-level types as nodes, so a `calls` edge to such a nested name
    // must NOT come out verified=true (otherwise the aggregator's
    // short-circuit would push it as a dangling edge → cytoscape blanks
    // the whole render). vscode-symbol-provider's flatten() now tags the
    // nested symbol with topLevel=false; the calibrator filters those
    // out before bestSymbolMatch.
    const c = new Calibrator(
      makeProvider({
        inFile: {
          'a.cs': [
            { ...sym('RecallQuery', 'a.cs', 1, 100), topLevel: true },
            { ...sym('ChunkHit', 'a.cs', 50, 60), topLevel: false },
          ],
        },
      }),
    );
    const out = await c.calibrate({
      data: { node_id: 'RecallQuery', calls: ['ChunkHit'] },
      file: 'a.cs',
      boundedContext: 'recall',
    });
    const edge = out!.edges.find(e => e.to === 'ChunkHit');
    expect(edge?.verified).toBe(false);
  });

  it('treats topLevel=undefined as top-level for backwards compatibility', async () => {
    // Mock providers and the workspace-lookup / regex-fallback paths in
    // vscode-symbol-provider do not set topLevel. Those candidates must
    // still match so this field's introduction is a pure additive signal.
    const c = new Calibrator(
      makeProvider({
        inFile: { 'a.cs': [sym('Foo', 'a.cs', 1, 10), sym('Bar', 'a.cs', 12, 20)] },
      }),
    );
    const out = await c.calibrate({
      data: { node_id: 'Foo', calls: ['Bar'] },
      file: 'a.cs',
      boundedContext: 'capture',
    });
    expect(out!.edges.find(e => e.to === 'Bar')?.verified).toBe(true);
  });

  it('emits external_calls as ext: edges regardless of workspace symbol presence', async () => {
    // Per W2 scope: we accept all external_calls. (Distinguishing package
    // imports from missing symbols lands in W3.)
    const c = new Calibrator(
      makeProvider({
        inFile: { 'a.cs': [sym('Foo', 'a.cs', 1, 10)] },
        workspace: { Dapper: [], Vector: [] },
      }),
    );
    const out = await c.calibrate({
      data: {
        node_id: 'Foo',
        external_calls: ['Dawning.ORM.Dapper', 'Pgvector.Vector'],
      },
      file: 'a.cs',
      boundedContext: 'capture',
    });
    expect(out?.edges.filter(e => e.kind === 'external_calls').map(e => e.to)).toEqual([
      'ext:Dawning.ORM.Dapper',
      'ext:Pgvector.Vector',
    ]);
  });

  it('honours dotted call targets (e.g. "Util.helper" → "Util")', async () => {
    const c = new Calibrator(
      makeProvider({
        inFile: {
          'a.cs': [sym('Foo', 'a.cs', 1, 10), sym('Util', 'a.cs', 12, 20)],
        },
      }),
    );
    const out = await c.calibrate({
      data: { node_id: 'Foo', calls: ['Util.helper'] },
      file: 'a.cs',
      boundedContext: 'capture',
    });
    expect(out?.node.verification).toBe('verified');
    expect(out?.edges[0]!.to).toBe('Util');
    expect(out?.edges[0]!.verified).toBe(true);
  });

  it('filters invalid risk types out', async () => {
    const c = new Calibrator(
      makeProvider({ inFile: { 'a.cs': [sym('Foo', 'a.cs', 1, 10)] } }),
    );
    const out = await c.calibrate({
      data: {
        node_id: 'Foo',
        risks: [
          { type: 'security', desc: 'x' },
          { type: 'made_up', desc: 'y' },        // dropped
          'concurrency',                          // accepted (string form)
          { type: 'unknown' },                    // dropped
        ],
      },
      file: 'a.cs',
      boundedContext: 'capture',
    });
    expect(out?.node.risks.map(r => r.type).sort()).toEqual(['concurrency', 'security']);
  });

  it('parses nested method blocks with intents and risks', async () => {
    const c = new Calibrator(
      makeProvider({ inFile: { 'a.cs': [sym('Foo', 'a.cs', 1, 100)] } }),
    );
    const out = await c.calibrate({
      data: {
        node_id: 'Foo',
        methods: [
          {
            name: 'doThing',
            signature: '(x, y)',
            line: 12,
            intent: 'process x and y',
            risks: ['concurrency', 'bogus'],
            calls: ['helper'],
            external_calls: ['HttpClient.GetAsync'],
          },
        ],
      },
      file: 'a.cs',
      boundedContext: 'capture',
    });
    expect(out?.node.methods).toHaveLength(1);
    const m = out!.node.methods[0]!;
    expect(m.name).toBe('doThing');
    expect(m.signature).toBe('(x, y)');
    expect(m.line).toBe(12);
    expect(m.intent).toBe('process x and y');
    expect(m.risks).toEqual(['concurrency']);     // 'bogus' filtered
    expect(m.calls).toEqual(['helper']);
    expect(m.externalCalls).toEqual(['HttpClient.GetAsync']);
  });

  it('strips generic parameters when matching node_id (Foo<T> → Foo)', async () => {
    const c = new Calibrator(
      makeProvider({ inFile: { 'a.cs': [sym('Foo', 'a.cs', 1, 10)] } }),
    );
    const out = await c.calibrate({
      data: { node_id: 'Foo<T>' },
      file: 'a.cs',
      boundedContext: 'capture',
    });
    expect(out?.node.verification).toBe('verified');
  });

  it('strips generic parameters from LSP symbol names too (Foo → Foo<T>)', async () => {
    // C# omnisharp / csharp LSP reports DocumentSymbol.name with type
    // parameters baked in, so `ValidationFilter<T>` is the LSP name even
    // when the LLM (which sees the source as a class declaration without
    // angle-brackets in the visible identifier) emits plain
    // `ValidationFilter`. The match must be symmetric.
    const c = new Calibrator(
      makeProvider({ inFile: { 'a.cs': [sym('ValidationFilter<T>', 'a.cs', 8, 33)] } }),
    );
    const out = await c.calibrate({
      data: { node_id: 'ValidationFilter', range: { startLine: 8, endLine: 33 } },
      file: 'a.cs',
      boundedContext: 'shared',
    });
    expect(out?.node.verification).toBe('verified');
    expect(out?.node.range).toEqual({ startLine: 8, endLine: 33 });
  });

  it('keeps verified state when LSP returns undefined (not ready), and flags lspNotReady', async () => {
    // "no signal" ≠ "negative signal". If the LSP hasn't indexed yet, we
    // must not silently mark every node unverified — that would lie to the
    // user and torpedo W4 prompt tuning.
    const c = new Calibrator(makeProvider({ inFile: { 'a.cs': undefined } }));
    const out = await c.calibrate({
      data: { node_id: 'Foo', calls: ['Bar'] },
      file: 'a.cs',
      boundedContext: 'capture',
    });
    expect(out?.node.verification).toBe('verified');
    expect(out?.node.verificationDetails?.lspNotReady).toBe(true);
    expect(out?.node.verificationDetails?.reason).toMatch(/Language server/);
    // Calls during lspNotReady are handed to the aggregator as unverified
    // (not silently kept as in-file).
    expect(out?.edges.find(e => e.to === 'Bar')?.verified).toBe(false);
  });

  describe('entry-point tagging (v3.5)', () => {
    it('reads is_entry / entry_kind / entry_meta off the raw block', async () => {
      const c = new Calibrator(
        makeProvider({ inFile: { 'a.cs': [sym('RecallEndpoints', 'a.cs', 1, 50)] } }),
      );
      const out = await c.calibrate({
        data: {
          node_id: 'RecallEndpoints',
          is_entry: true,
          entry_kind: 'http_endpoint',
          entry_meta: { routes: ['GET /recall', 'POST /recall/feedback'] },
        },
        file: 'a.cs',
        boundedContext: 'recall',
      });
      expect(out?.node.isEntry).toBe(true);
      expect(out?.node.entryKind).toBe('http_endpoint');
      expect(out?.node.entryMeta?.routes).toEqual(['GET /recall', 'POST /recall/feedback']);
    });

    it('leaves entry fields undefined when is_entry is omitted', async () => {
      const c = new Calibrator(
        makeProvider({ inFile: { 'a.cs': [sym('UserService', 'a.cs', 1, 50)] } }),
      );
      const out = await c.calibrate({
        data: { node_id: 'UserService' },
        file: 'a.cs',
        boundedContext: 'identity',
      });
      expect(out?.node.isEntry).toBeUndefined();
      expect(out?.node.entryKind).toBeUndefined();
      expect(out?.node.entryMeta).toBeUndefined();
    });

    it('treats is_entry: false as not an entry (no leakage of entry_kind)', async () => {
      const c = new Calibrator(
        makeProvider({ inFile: { 'a.cs': [sym('UserService', 'a.cs', 1, 50)] } }),
      );
      const out = await c.calibrate({
        data: { node_id: 'UserService', is_entry: false, entry_kind: 'http_endpoint' },
        file: 'a.cs',
        boundedContext: 'identity',
      });
      expect(out?.node.isEntry).toBeUndefined();
      expect(out?.node.entryKind).toBeUndefined();
    });

    it('drops an unknown entry_kind but keeps isEntry=true', async () => {
      const c = new Calibrator(
        makeProvider({ inFile: { 'a.cs': [sym('Weird', 'a.cs', 1, 50)] } }),
      );
      const out = await c.calibrate({
        data: { node_id: 'Weird', is_entry: true, entry_kind: 'webhook' },
        file: 'a.cs',
        boundedContext: 'shared',
      });
      expect(out?.node.isEntry).toBe(true);
      expect(out?.node.entryKind).toBeUndefined();
    });

    it('parses all entry_meta variants and omits empty fields', async () => {
      const c = new Calibrator(
        makeProvider({ inFile: { 'a.cs': [sym('Sdk', 'a.cs', 1, 50)] } }),
      );
      const out = await c.calibrate({
        data: {
          node_id: 'Sdk',
          is_entry: true,
          entry_kind: 'public_api',
          entry_meta: {
            publicApis: ['AddDawningCaching', 'UseDawningCaching'],
            routes: [],            // empty arrays should not appear on output
            sampleName: '',         // empty string should not appear
          },
        },
        file: 'a.cs',
        boundedContext: 'caching',
      });
      expect(out?.node.entryMeta?.publicApis).toEqual([
        'AddDawningCaching',
        'UseDawningCaching',
      ]);
      expect(out?.node.entryMeta?.routes).toBeUndefined();
      expect(out?.node.entryMeta?.sampleName).toBeUndefined();
    });

    it('accepts snake_case meta keys (sample_name, public_apis) for LLM tolerance', async () => {
      const c = new Calibrator(
        makeProvider({ inFile: { 'a.cs': [sym('BasicCachingSample', 'a.cs', 1, 50)] } }),
      );
      const out = await c.calibrate({
        data: {
          node_id: 'BasicCachingSample',
          is_entry: true,
          entry_kind: 'sample',
          entry_meta: { sample_name: 'BasicCaching' },
        },
        file: 'a.cs',
        boundedContext: 'samples',
      });
      expect(out?.node.entryMeta?.sampleName).toBe('BasicCaching');
    });
  });
});
