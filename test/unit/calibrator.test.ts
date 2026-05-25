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

  it('drops bare verb-prefix external_calls (extension methods) but keeps bare type names for aggregator promotion', async () => {
    // v8 rollback verification: the v6/v7 bare-name filters are gone. The
    // calibrator accepts every well-formed external_calls entry; downstream
    // (aggregator) is responsible for any node-level noise filtering (e.g.
    // top-level-statements Program drop). This test pins the no-filter
    // contract so a future regression that re-introduces bare-name dropping
    // at the calibrator level is caught immediately.
    const c = new Calibrator(
      makeProvider({ inFile: { 'a.cs': [sym('Program', 'a.cs', 1, 100)] } }),
    );
    const out = await c.calibrate({
      data: {
        node_id: 'Program',
        external_calls: [
          'AddCaptureModule',
          'MapRecallEndpoints',
          'UseExceptionHandler',
          'IRecallQuery',
          'AskByQueryRequest',
          'WebApplication.CreateBuilder',
        ],
      },
      file: 'a.cs',
      boundedContext: 'host',
    });
    const externalEdges = out?.edges.filter(e => e.kind === 'external_calls').map(e => e.to);
    expect(externalEdges).toEqual([
      'ext:AddCaptureModule',
      'ext:MapRecallEndpoints',
      'ext:UseExceptionHandler',
      'ext:IRecallQuery',
      'ext:AskByQueryRequest',
      'ext:WebApplication.CreateBuilder',
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

  it('preserves method-level calls in all three forms verbatim (bare sibling / Class.Method / bare Class)', async () => {
    // The webview's __cmResolveCallTarget resolves bare `<Method>` as a
    // same-class sibling, `<Class>.<Method>` as an explicit method node id,
    // and bare `<Class>` as a compound parent. The calibrator should pass
    // all three through unchanged — it is not the right layer to validate
    // method-level targets (the webview's resolver does the de-facto check
    // by silently dropping unresolvable ids when no matching node exists).
    const c = new Calibrator(
      makeProvider({ inFile: { 'a.cs': [sym('AuthController', 'a.cs', 1, 200)] } }),
    );
    const out = await c.calibrate({
      data: {
        node_id: 'AuthController',
        methods: [
          {
            name: 'Exchange',
            signature: '()',
            line: 36,
            calls: [
              'HandlePasswordGrantAsync',                              // bare sibling
              'AuthController.HandleClientCredentialsGrantAsync',      // explicit Class.Method
              'IUserAuthenticationService.AuthenticateAsync',          // cross-class Class.Method
              'OpenIddictRequest',                                     // bare class (type dep)
            ],
          },
        ],
      },
      file: 'a.cs',
      boundedContext: 'host',
    });
    const m = out!.node.methods[0]!;
    expect(m.calls).toEqual([
      'HandlePasswordGrantAsync',
      'AuthController.HandleClientCredentialsGrantAsync',
      'IUserAuthenticationService.AuthenticateAsync',
      'OpenIddictRequest',
    ]);
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

  describe('entry-point tagging (v3.6 — kind-strip)', () => {
    it('drops sampleName when entry_kind is cli_main (v3.5 EvalHostBuilder bug)', async () => {
      const c = new Calibrator(
        makeProvider({ inFile: { 'host.cs': [sym('EvalHostBuilder', 'host.cs', 1, 50)] } }),
      );
      const out = await c.calibrate({
        data: {
          node_id: 'EvalHostBuilder',
          is_entry: true,
          entry_kind: 'cli_main',
          entry_meta: {
            commands: ['eval', 'replay'],
            sampleName: 'EvalHostBuilder', // wrong field for cli_main
          },
        },
        file: 'host.cs',
        boundedContext: 'eval',
      });
      expect(out?.node.entryKind).toBe('cli_main');
      expect(out?.node.entryMeta?.commands).toEqual(['eval', 'replay']);
      expect(out?.node.entryMeta?.sampleName).toBeUndefined();
    });

    it('drops routes when entry_kind is worker', async () => {
      const c = new Calibrator(
        makeProvider({ inFile: { 'w.cs': [sym('IndexerWorker', 'w.cs', 1, 50)] } }),
      );
      const out = await c.calibrate({
        data: {
          node_id: 'IndexerWorker',
          is_entry: true,
          entry_kind: 'worker',
          entry_meta: {
            routes: ['GET /healthz'], // wrong field for worker
          },
        },
        file: 'w.cs',
        boundedContext: 'index',
      });
      expect(out?.node.entryKind).toBe('worker');
      expect(out?.node.entryMeta).toBeUndefined();
    });

    it('drops publicApis when entry_kind is http_endpoint', async () => {
      const c = new Calibrator(
        makeProvider({ inFile: { 'r.cs': [sym('RecallEndpoints', 'r.cs', 1, 50)] } }),
      );
      const out = await c.calibrate({
        data: {
          node_id: 'RecallEndpoints',
          is_entry: true,
          entry_kind: 'http_endpoint',
          entry_meta: {
            routes: ['GET /recall'],
            publicApis: ['MapRecallRoutes'], // wrong field for http_endpoint
          },
        },
        file: 'r.cs',
        boundedContext: 'recall',
      });
      expect(out?.node.entryMeta?.routes).toEqual(['GET /recall']);
      expect(out?.node.entryMeta?.publicApis).toBeUndefined();
    });

    it('drops commands when entry_kind is public_api', async () => {
      const c = new Calibrator(
        makeProvider({ inFile: { 's.cs': [sym('ServiceCollectionExtensions', 's.cs', 1, 50)] } }),
      );
      const out = await c.calibrate({
        data: {
          node_id: 'ServiceCollectionExtensions',
          is_entry: true,
          entry_kind: 'public_api',
          entry_meta: {
            publicApis: ['AddDawningCaching'],
            commands: ['ghost'], // wrong field for public_api
          },
        },
        file: 's.cs',
        boundedContext: 'caching',
      });
      expect(out?.node.entryMeta?.publicApis).toEqual(['AddDawningCaching']);
      expect(out?.node.entryMeta?.commands).toBeUndefined();
    });

    it('keeps all meta fields when entry_kind is missing (calibrator cannot decide)', async () => {
      const c = new Calibrator(
        makeProvider({ inFile: { 'a.cs': [sym('Unknown', 'a.cs', 1, 50)] } }),
      );
      const out = await c.calibrate({
        data: {
          node_id: 'Unknown',
          is_entry: true,
          // entry_kind intentionally omitted
          entry_meta: {
            routes: ['GET /x'],
            commands: ['y'],
          },
        },
        file: 'a.cs',
        boundedContext: 'misc',
      });
      expect(out?.node.entryKind).toBeUndefined();
      expect(out?.node.entryMeta?.routes).toEqual(['GET /x']);
      expect(out?.node.entryMeta?.commands).toEqual(['y']);
    });
  });
});
