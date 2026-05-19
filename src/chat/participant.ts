import * as vscode from 'vscode';
import { routeChatIntent, type ChatIntent } from './intent-router';
import { normalizeScopePath } from './scope';
import { showGraph } from '../webview/panel';
import { runOrchestrator, CancelledError } from '../orchestrator/orchestrator';
import { createVscodeFileReader } from '../orchestrator/vscode-file-reader';
import { VscodeSymbolProvider } from '../calibration/vscode-symbol-provider';
import { VscodeLmClient } from '../llm/client';
import { loadGoldenForWorkspace } from '../eval/golden-loader';
import { scoreGraph } from '../eval/score';
import { DEFAULT_SCAN_OPTIONS } from '../orchestrator/workspace-scanner';
import type { MockupChatTurn } from '../webview/graph-adapter';
import { GraphStore, currentWorkspaceRevHash, type StoredGraph } from '../persistence/graph-store';
import { explainNode, explainUnverified, focusSubgraph } from './chat-responders';

const PARTICIPANT_ID = 'codemap.codemap';

export function registerChatParticipant(context: vscode.ExtensionContext): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, _ctx, response, token) => {
    const intent = routeChatIntent(request);

    if (token.isCancellationRequested) return;

    switch (intent.kind) {
      case 'generate_workspace':
      case 'scope':
        await handleGenerate(context, intent, request.model, response, token);
        return;
      case 'focus':
        await handleFocus(context, intent, request.model, response, token);
        return;
      case 'why':
        await handleWhy(context, intent, response);
        return;
      case 'explain':
        await handleExplain(context, response);
        return;
      case 'unknown':
        response.markdown(
          [
            'Try one of:',
            '- `@codemap generate codemap` — analyze the whole workspace',
            '- `@codemap /scope <path>` — limit to a subpath',
            '- `@codemap /focus <Class>` — re-center the graph on a class',
            '- `@codemap /why <Class>` — explain partial/unverified state',
            '- `@codemap /explain unverified` — list all unverified nodes in the current graph',
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

  const scopePrefix =
    intent.kind === 'scope' && intent.target
      ? normalizeScopePath(intent.target, workspaceFolder.uri.fsPath)
      : undefined;
  const rootRequest =
    intent.kind === 'scope' && intent.target
      ? `@codemap /scope ${intent.target}`
      : `@codemap ${intent.prompt}`;

  response.markdown(`Analyzing workspace **\`${workspaceFolder.name}\`** with \`${modelLabel}\`...\n\n`);
  if (scopePrefix) response.markdown(`Scope filter: \`${scopePrefix}\` (workspace-relative)\n\n`);
  else if (intent.kind === 'scope' && intent.target)
    response.markdown(
      `⚠ Scope \`${intent.target}\` is outside this workspace — analyzing the entire workspace instead.\n\n`,
    );

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
    let evalScore:
      | { nodes: { precision: number; recall: number; f1: number }; edges: { precision: number; recall: number; f1: number } }
      | undefined;
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
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    const stats = {
      verifiedCount: result.stats.verifiedCount,
      partialCount: result.stats.partialCount,
      unverifiedCount: result.stats.unverifiedCount,
      filesAnalyzed: result.stats.filesAnalyzed,
      filesFailed: result.stats.filesFailed,
      durationMs: result.stats.durationMs,
      eval: evalScore,
    };

    await showGraph(context, result.graph, chatTurns, stats, {
      modelLabel,
      repoName: workspaceFolder.name,
      scope: scopePrefix,
      fileCountText: `${result.stats.filesAnalyzed} files analyzed`,
      scopePill: scopePrefix ? '📦 SCOPED' : '📦 WORKSPACE',
    });

    // ---- Persist for /why, /explain, /focus and reloads. ----
    await new GraphStore(context.workspaceState).save({
      graph: result.graph,
      chatTurns,
      revHash: currentWorkspaceRevHash(),
      savedAt: Date.now(),
      stats,
    });
  } catch (err) {
    if (err instanceof CancelledError) {
      response.markdown('\n_Cancelled._');
      return;
    }
    const e = err as Error;
    response.markdown(
      [
        '',
        `⚠ **Error**: ${e.message}`,
        '',
        'Common causes:',
        '- Copilot Chat not signed in (the LLM call needs `vscode.lm`).',
        '- Workspace has no `.cs/.ts/.tsx/.js/.jsx` files (scanner extension whitelist).',
        '- C# Dev Kit / TS LSP not finished indexing yet — try again in a moment.',
      ].join('\n'),
    );
  }
}

async function handleWhy(
  context: vscode.ExtensionContext,
  intent: ChatIntent,
  response: vscode.ChatResponseStream,
): Promise<void> {
  if (!intent.target) {
    response.markdown(
      'Usage: `@codemap /why <Class>`. Example: `@codemap /why AskByQueryHandler`.',
    );
    return;
  }
  const stored = loadCurrentGraph(context);
  if (!stored) {
    response.markdown(noGraphHint());
    return;
  }
  response.markdown(explainNode(stored.graph, intent.target).markdown);
}

async function handleExplain(
  context: vscode.ExtensionContext,
  response: vscode.ChatResponseStream,
): Promise<void> {
  const stored = loadCurrentGraph(context);
  if (!stored) {
    response.markdown(noGraphHint());
    return;
  }
  response.markdown(explainUnverified(stored.graph).markdown);
}

async function handleFocus(
  context: vscode.ExtensionContext,
  intent: ChatIntent,
  pickedModel: vscode.LanguageModelChat | undefined,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  if (!intent.target) {
    response.markdown(
      'Usage: `@codemap /focus <Class>`. Example: `@codemap /focus IngestUrlHandler`.',
    );
    return;
  }
  const stored = loadCurrentGraph(context);
  if (!stored) {
    response.markdown(
      '_No current graph in this workspace yet. Running a full analysis first; ' +
        'then re-issue `/focus` to narrow down._',
    );
    // Fall back to a fresh generate so the user isn't stuck. We pass the
    // original prompt body so /focus <Class> still results in a workspace
    // generation rather than crashing.
    await handleGenerate(
      context,
      { kind: 'generate_workspace', prompt: intent.prompt },
      pickedModel,
      response,
      token,
    );
    return;
  }

  const focus = focusSubgraph(stored.graph, intent.target);
  response.markdown(focus.markdown);
  if (!focus.found || !focus.subgraph) return;

  await showGraph(
    context,
    focus.subgraph,
    [
      ...stored.chatTurns,
      {
        role: 'user',
        name: 'You',
        time: nowHHMM(),
        content: escapeHtml(`@codemap /focus ${intent.target}`),
      },
      {
        role: 'assistant',
        name: '@codemap',
        time: nowHHMM(),
        content: `Re-centered on <code>${escapeHtml(intent.target)}</code>: ${focus.includedIds.length} nodes (target + ${focus.includedIds.length - 1} neighbors).`,
      },
    ],
    stored.stats,
    {
      modelLabel: 'focus (no model call)',
      repoName: vscode.workspace.workspaceFolders?.[0]?.name ?? 'workspace',
      scope: `focus:${intent.target}`,
      fileCountText: `${focus.includedIds.length} classes in focus`,
      scopePill: '🎯 FOCUS',
    },
  );

  // /focus is transient: don't overwrite the persisted full graph so /why
  // and /explain still see the complete picture.
}

function loadCurrentGraph(context: vscode.ExtensionContext): StoredGraph | undefined {
  return new GraphStore(context.workspaceState).load(currentWorkspaceRevHash());
}

function noGraphHint(): string {
  return (
    '_No graph available for this workspace yet._ ' +
    'Run `@codemap generate codemap` first, then re-issue this command.'
  );
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
