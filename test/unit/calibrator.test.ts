import { describe, it, expect } from 'vitest';
import { Calibrator } from '../../src/calibration/calibrator';
import type { SymbolProvider, SymbolHit } from '../../src/calibration/symbol-provider';

function makeProvider(args: {
  inFile?: Record<string, SymbolHit[]>;
  workspace?: Record<string, SymbolHit[]>;
}): SymbolProvider {
  return {
    async symbolsInFile(file) {
      return args.inFile?.[file] ?? [];
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

  it('drops calls targets not present in the file and downgrades to partial', async () => {
    const c = new Calibrator(
      makeProvider({
        inFile: {
          'a.cs': [sym('Foo', 'a.cs', 1, 10), sym('Bar', 'a.cs', 12, 20)],
        },
      }),
    );
    const out = await c.calibrate({
      data: { node_id: 'Foo', calls: ['Bar', 'GhostClass'] },
      file: 'a.cs',
      boundedContext: 'capture',
    });
    expect(out?.node.verification).toBe('partial');
    expect(out?.node.verificationDetails?.droppedCalls).toEqual(['GhostClass']);
    // Only the verified call survives as an edge.
    expect(out?.edges.map(e => e.to)).toEqual(['Bar']);
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

  it('honours dotted call targets (e.g. "Util.helper" → "helper")', async () => {
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
    // Both kept (Util matched), no drops.
    expect(out?.node.verification).toBe('verified');
    expect(out?.edges[0]!.to).toBe('Util');
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
});
