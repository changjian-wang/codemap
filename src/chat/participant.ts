import * as vscode from 'vscode';
import { routeChatIntent, type ChatIntent } from './intent-router';
import { showGraph, showDemoGraph } from '../webview/panel';
import { runOrchestrator, CancelledError } from '../orchestrator/orchestrator';
import { createVscodeFileReader } from '../orchestrator/vscode-file-reader';
import { VscodeSymbolProvider } from '../calibration/vscode-symbol-provider';
import { VscodeLmClient } from '../llm/client';
import { loadGoldenForWorkspace } from '../eval/golden-loader';
import { scoreGraph } from '../eval/score';
import { DEFAULT_SCAN_OPTIONS } from '../orchestrator/workspace-scanner';
import type { MockupChatTurn } from '../webview/graph-adapter';

const PARTICIPANT_ID = 'codemap.codemap';

export function registerChatParticipant(context: vscode.ExtensionContext): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, _ctx, response, token) => {
    const intent = routeChatIntent(request);

    if (token.isCancellationRequested) return;

    switch (intent.kind) {
      case 'generate_workspace':
      case 'scope':
      case 'focus':
        await handleGenerate(context, intent, request.model, response, token);
        return;
      case 'why':
        response.markdown(
          intent.target
            ? `_Stub_: would explain why \`${intent.target}\` is partial/unverified. (W4 task 4.8: translate node.verificationDetails into prose.)`
            : '_Stub_: pass a class name, e.g. `/why AskByQueryHandler`.',
        );
        return;
      case 'explain':
        response.markdown(
          '_Stub_: would list all unverified nodes in the current graph with their reasons. (W4 task 4.8.)',
        );
        return;
      case 'unknown':
        response.markdown(
          [
            'Try one of:',
            '- `@codemap generate codemap` — analyze the whole workspace',
            '- `@codemap /scope <path>` — limit to a subpath',
            '- `@codemap /focus <Class>` — re-center on a class (W4)',
            '- `@codemap /why <Class>` — explain partial/unverified state (W4)',
            '- `@codemap /explain unverified` — explain all unverified nodes (W4)',
          ].join('\n'),
        );
        return;
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon('graph');
  return participant;
}

async function handleGenerate(
  context: vscode.ExtensionContext,
  intent: ChatIntent,
  pickedModel: vscode.LanguageModelChat | undefined,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    response.markdown('⚠ No workspace folder open. Open a folder first, then try again.');
    return;
  }

  const config = vscode.workspace.getConfiguration('codemap');
  const fallbackFamily = config.get<string>('preferredModelFamily', 'gpt-4o');
  const maxFiles = config.get<number>('maxSkeletonFiles', 30);
  const maxParallel = config.get<number>('maxParallelAnalyzers', 6);

  // Prefer the model the user picked in the Copilot Chat picker. The
  // settings-based `preferredModelFamily` is only a fallback for when the
  // command is invoked outside a chat turn.
  const modelLabel = pickedModel
    ? `${pickedModel.name ?? pickedModel.family}${pickedModel.vendor ? ` (${pickedModel.vendor})` : ''}`
    : fallbackFamily;

  const scopePrefix = intent.kind === 'scope' && intent.target ? intent.target : undefined;
  const rootRequest =
    intent.kind === 'scope' && intent.target
      ? `@codemap /scope ${intent.target}`
      : intent.kind === 'focus' && intent.target
        ? `@codemap /focus ${intent.target}`
        : `@codemap ${intent.prompt}`;

  response.markdown(`Analyzing workspace **\`${workspaceFolder.name}\`** with \`${modelLabel}\`...\n\n`);
  if (scopePrefix) response.markdown(`Scope filter: \`${scopePrefix}\`\n\n`);

  const chatTurns: MockupChatTurn[] = [
    {
      role: 'user',
      name: 'You',
      time: nowHHMM(),
      content: escapeHtml(rootRequest),
    },
  ];
  const actionTrace: { check: boolean; num: string; text: string }[] = [];

  try {
    const result = await runOrchestrator(
      {
        reader: createVscodeFileReader(workspaceFolder.uri, {
          ...DEFAULT_SCAN_OPTIONS,
          maxFiles,
        }),
        symbols: new VscodeSymbolProvider(workspaceFolder.uri),
        llm: new VscodeLmClient(fallbackFamily, pickedModel),
      },
      {
        rootRequest,
        scope: scopePrefix ?? 'workspace',
        scopePrefix,
        scan: { maxFiles },
        maxParallelAnalyzers: maxParallel,
      },
      {
        onStep: msg => {
          actionTrace.push({ check: true, num: String(actionTrace.length + 1), text: msg });
          response.progress(msg);
        },
        onSkeleton: info => {
          const txt = `Picked skeleton: ${info.skeleton.length} files (entries: ${info.entryPoints.length}, overflow: ${info.overflow.length})`;
          actionTrace.push({ check: true, num: String(actionTrace.length + 1), text: txt });
          response.markdown(`\n${txt}\n`);
        },
        onFileDone: info => {
          if (info.error) {
            response.markdown(`\n- ⚠ \`${info.file}\` failed: ${info.error.message}`);
          }
          response.progress(`Analyzing... ${info.doneCount}/${info.total}`);
        },
        onWarning: msg => response.markdown(`\n- ⚠ ${msg}`),
      },
      token,
    );

    response.markdown(
      [
        '',
        `**Done in ${(result.stats.durationMs / 1000).toFixed(1)}s.** ` +
          `${result.stats.nodeCount} classes, ${result.stats.edgeCount} edges.`,
        `Verification: ✓ ${result.stats.verifiedCount} verified · ⚠ ${result.stats.partialCount} partial · ✗ ${result.stats.unverifiedCount} unverified.`,
        result.graph.rootIntent ? `\n_${result.graph.rootIntent}_` : '',
        result.graph.suggestedEntryNodes && result.graph.suggestedEntryNodes.length > 0
          ? `Suggested reading entry: \`${result.graph.suggestedEntryNodes[0]}\``
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );

    chatTurns.push({
      role: 'assistant',
      name: '@codemap',
      time: nowHHMM(),
      content:
        `Generated <code>${result.stats.nodeCount}</code> classes and <code>${result.stats.edgeCount}</code> edges. ` +
        `Calibration: ✓ ${result.stats.verifiedCount} / ⚠ ${result.stats.partialCount} / ✗ ${result.stats.unverifiedCount}. ` +
        `Took ${(result.stats.durationMs / 1000).toFixed(1)}s.`,
      actions: actionTrace,
    });

    // ---- Optional eval against a golden sample ----
    const golden = await loadGoldenForWorkspace(workspaceFolder.uri);
    let evalScore: { nodes: { precision: number; recall: number; f1: number }; edges: { precision: number; recall: number; f1: number } } | undefined;
    if (golden) {
      const sc = scoreGraph(result.graph, golden);
      evalScore = { nodes: sc.nodes, edges: sc.edges };
      response.markdown(
        [
          '',
          `**Eval against \`${golden.name}\`**:`,
          `- Nodes: P=${sc.nodes.precision.toFixed(2)} · R=${sc.nodes.recall.toFixed(2)} · F1=${sc.nodes.f1.toFixed(2)}`,
          `- Edges: P=${sc.edges.precision.toFixed(2)} · R=${sc.edges.recall.toFixed(2)} · F1=${sc.edges.f1.toFixed(2)}`,
          sc.diff.missingNodes.length > 0
            ? `- Missing nodes: ${sc.diff.missingNodes.map(n => '`' + n + '`').join(', ')}`
            : '',
          sc.diff.missingEdges.length > 0
            ? `- Missing edges: ${sc.diff.missingEdges.slice(0, 5).map(e => `\`${e.from}→${e.to}\``).join(', ')}${sc.diff.missingEdges.length > 5 ? ` (+${sc.diff.missingEdges.length - 5} more)` : ''}`
            : '',
        ].filter(Boolean).join('\n'),
      );
    }

    await showGraph(
      context,
      result.graph,
      chatTurns,
      {
        verifiedCount: result.stats.verifiedCount,
        partialCount: result.stats.partialCount,
        unverifiedCount: result.stats.unverifiedCount,
        filesAnalyzed: result.stats.filesAnalyzed,
        filesFailed: result.stats.filesFailed,
        durationMs: result.stats.durationMs,
        eval: evalScore,
      },
      {
        modelLabel,
        repoName: workspaceFolder.name,
        scope: scopePrefix,
        fileCountText: `${result.stats.filesAnalyzed} files analyzed`,
        scopePill: scopePrefix ? '📦 SCOPED' : '📦 WORKSPACE',
      },
    );
  } catch (err) {
    if (err instanceof CancelledError) {
      response.markdown('\n_Cancelled._');
      return;
    }
    const e = err as Error;
    response.markdown(`\n\n⚠ **Error**: ${e.message}\n\n_Falling back to the demo graph._`);
    await showDemoGraph(context);
  }
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
