import type * as vscode from 'vscode';
import type { CodeNode, CodeEdge } from '../shared/types';
import type { LlmClient } from '../llm/client';
import { SYSTEM_PROMPT, buildUserMessage } from '../llm/prompts';
import { CodemapMetaStreamParser, type RawBlock } from '../llm/stream-parser';
import { Calibrator } from '../calibration/calibrator';
import type { SymbolProvider } from '../calibration/symbol-provider';

/**
 * Per-file pipeline: stream-from-LLM → parse meta blocks → calibrate → emit.
 *
 * One {@link SingleFileAnalyzer} is created per file (cheap; no shared state).
 * Output is the file's partial graph: a list of CodeNodes and edges that
 * reference symbols defined in this file. Cross-file edges are resolved by
 * the W3 aggregator using the workspace symbol provider; here we keep edges
 * as-is, prefixed `ext:` for `external_calls`.
 *
 * The analyzer is constructor-injected with both the LLM client and the
 * symbol provider, so tests can fake both without spinning up a vscode
 * runtime (see test/unit/single-file-analyzer.test.ts).
 */

export interface AnalyzeResult {
  file: string;
  nodes: CodeNode[];
  edges: CodeEdge[];
  rootIntent?: string;
  narrative?: string;
  suggestedEntryNodes?: string[];
  parseErrors: { reason: string; raw: string }[];
}

export interface AnalyzeInput {
  file: string;
  fileText: string;
  boundedContext: string;
  token: vscode.CancellationToken;
  /**
   * Optional callback fired each time a calibrated node is ready. Lets the
   * UI stream nodes into the WebView as they come in (v3 plan §4 streaming
   * design); call site can ignore it for a batched workflow.
   */
  onNode?: (node: CodeNode, edges: CodeEdge[]) => void;
}

export class SingleFileAnalyzer {
  private calibrator: Calibrator;

  constructor(private llm: LlmClient, symbols: SymbolProvider) {
    this.calibrator = new Calibrator(symbols);
  }

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    const { file, fileText, boundedContext, token } = input;
    const userMessage = buildUserMessage(file, fileText);

    const parseErrors: AnalyzeResult['parseErrors'] = [];
    const parser = new CodemapMetaStreamParser({
      onError: e => parseErrors.push(e),
    });

    const nodes: CodeNode[] = [];
    const edges: CodeEdge[] = [];
    let rootIntent: string | undefined;
    let narrative: string | undefined;
    let suggestedEntryNodes: string[] | undefined;

    const handleBlock = async (b: RawBlock): Promise<void> => {
      if (b.kind === 'summary') {
        const d = b.data as Record<string, unknown>;
        if (typeof d.root_intent === 'string') rootIntent = d.root_intent;
        if (typeof d.narrative === 'string') narrative = d.narrative;
        if (Array.isArray(d.suggested_entry_nodes)) {
          suggestedEntryNodes = (d.suggested_entry_nodes as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          );
        }
        return;
      }
      const result = await this.calibrator.calibrate({
        data: b.data,
        file,
        boundedContext,
      });
      if (!result) return;
      nodes.push(result.node);
      edges.push(...result.edges);
      input.onNode?.(result.node, result.edges);
    };

    for await (const fragment of this.llm.stream(SYSTEM_PROMPT, userMessage, token)) {
      if (token.isCancellationRequested) break;
      const blocks = parser.feed(fragment);
      for (const b of blocks) await handleBlock(b);
    }
    parser.flush();

    return { file, nodes, edges, rootIntent, narrative, suggestedEntryNodes, parseErrors };
  }
}
