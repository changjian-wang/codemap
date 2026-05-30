// Phase 3.3b -- intent-routed chat participant for the v4 stack.
//
// Wires the v4 orchestrator (scanner -> analyzer -> calibrator -> aggregator)
// into the @codemap chat surface. Slash commands dispatch through
// responders.ts for /why, /focus, /explain, /entries; /eval is deferred
// to Phase 3.4 (scorer rewrite). The most recently generated graph is
// kept in a module-level slot and reused by the sub-commands.

import * as vscode from 'vscode';
import * as path from 'path';
import { routeChatIntent, type ChatIntent } from './intent-router';
import { resolveScope } from './scope';
import {
  explainClass,
  explainUnverified,
  focusSubgraph,
  formatVerificationDigest,
  listEntries,
} from './responders';
import { showGraph } from '../webview/panel';
import { runOrchestrator, type OrchestratorResult } from '../orchestrator/orchestrator';
import { createVscodeFileReader } from '../orchestrator/vscode-file-reader';
import { DEFAULT_SCAN_OPTIONS } from '../orchestrator/workspace-scanner';
import { VscodeLmClient } from '../orchestrator/vscode-lm-client';
import { CalibratorRegistry } from '../calibration/registry';
import { CSharpCalibratorHost } from '../calibration/host/csharp-host';
import type { CodeMapGraph } from '../shared/types';
import type { CalibratorService } from '../calibration/calibrator-service';

const PARTICIPANT_ID = 'codemap.codemap';
const DEFAULT_CSHARP_EXE_REL =
  'tools/codemap-calibrator-csharp/bin/Debug/net8.0/codemap-calibrator-csharp';

interface CachedGraph {
  graph: CodeMapGraph;
  folder: vscode.WorkspaceFolder;
  generatedAt: number;
}

let lastGraph: CachedGraph | null = null;

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
        await handleFocus(context, intent, response);
        return;
      case 'why':
        await handleWhy(intent, response);
        return;
      case 'explain':
        await handleExplain(response);
        return;
      case 'eval':
        await handleEval(response);
        return;
      case 'entries':
        await handleEntries(response);
        return;
      case 'unknown':
        response.markdown(
          [
            'Try one of:',
            '- `@codemap generate codemap` -- analyze the whole workspace',
            '- `@codemap /scope <path>` -- limit to a subpath',
            '- `@codemap /focus <Class>` -- re-center the graph on a class',
            '- `@codemap /why <Class>` -- explain partial/unverified state',
            '- `@codemap /explain unverified` -- list every unverified class',
            '- `@codemap /entries` -- list entry-point classes',
            '- `@codemap /eval` -- _(deferred to Phase 3.4 -- v2 scorer)_',
          ].join('\n'),
        );
        return;
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon('graph');
  return participant;
}

// -------------------------------------------------------------------------
//   /generate, /scope -- full orchestrator run
// -------------------------------------------------------------------------

async function handleGenerate(
  context: vscode.ExtensionContext,
  intent: ChatIntent,
  pickedModel: vscode.LanguageModelChat | undefined,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    response.markdown('WARN No workspace folder open. Open a folder first, then try again.');
    return;
  }

  const config = vscode.workspace.getConfiguration('codemap');
  const fallbackFamily = config.get<string>('preferredModelFamily', 'gpt-4o');
  const maxFiles = config.get<number>('maxSkeletonFiles', 60);
  const maxParallel = config.get<number>('maxParallelAnalyzers', 6);
  const csharpExeSetting = config.get<string>('csharpExecutable', '');

  const modelLabel = pickedModel
    ? `${pickedModel.name ?? pickedModel.family}${pickedModel.vendor ? ` (${pickedModel.vendor})` : ''}`
    : fallbackFamily;

  const resolved =
    intent.kind === 'scope' && intent.target
      ? resolveScope(intent.target, folders)
      : undefined;
  if (intent.kind === 'scope' && intent.target && !resolved) {
    const folderList = folders.map((f) => `\`${f.name}\``).join(', ');
    response.markdown(
      [
        `WARN Scope \`${intent.target}\` is ambiguous in this multi-root workspace.`,
        '',
        `Open folders: ${folderList}.`,
        '',
        'Disambiguate with one of:',
        ...folders.map((f) => `- \`@codemap /scope ${f.name}/${intent.target}\``),
        '- `@codemap /scope "<absolute path>"`',
      ].join('\n'),
    );
    return;
  }

  const workspaceFolder = resolved?.folder ?? folders[0]!;
  const scopePrefix = resolved?.prefix || undefined;
  const rootRequest =
    intent.kind === 'scope' && intent.target
      ? `@codemap /scope ${intent.target}`
      : `@codemap ${intent.prompt}`;

  response.markdown(`Analyzing workspace **\`${workspaceFolder.name}\`** with \`${modelLabel}\`...\n\n`);
  if (scopePrefix) response.markdown(`Scope filter: \`${scopePrefix}\` in \`${workspaceFolder.name}\`\n\n`);

  const ac = new AbortController();
  const onCancel = token.onCancellationRequested(() => ac.abort());

  const csharpExe = resolveCsharpExe(context, workspaceFolder, csharpExeSetting);
  const registry = new CalibratorRegistry({
    csharpExecutable: csharpExe,
    workspaceRoot: workspaceFolder.uri.fsPath,
  });
  const loaded = await preloadCalibrators(workspaceFolder, registry, response);

  const reader = createVscodeFileReader(workspaceFolder.uri, {
    ...DEFAULT_SCAN_OPTIONS,
    maxFiles,
  });
  const llm = new VscodeLmClient({
    preferredModel: pickedModel,
    fallbackFamily,
  });

  let result: OrchestratorResult;
  try {
    result = await runOrchestrator(
      {
        reader,
        llm,
        calibratorFor: (lang) => calibratorForLang(lang, registry, loaded),
      },
      {
        rootRequest,
        scope: scopePrefix ?? 'workspace',
        scopePrefix,
        workspaceRoot: workspaceFolder.uri.toString(),
        scan: { maxFiles },
        analyzeConcurrency: maxParallel,
      },
      {
        onStep: (msg) => response.progress(msg),
        onSkeleton: (files) =>
          response.markdown(`\nPicked skeleton: **${files.length}** file(s).\n`),
        onFileAnalyzed: (info) => {
          const icon = info.error ? 'WARN' : 'OK';
          const detail = info.error ? `: ${info.error.message}` : '';
          response.markdown(`\n- ${icon} \`${info.file}\`${detail}`);
        },
      },
      ac.signal,
    );
  } catch (e) {
    response.markdown(`\n\nMISS Orchestrator failed: \`${(e as Error).message}\``);
    return;
  } finally {
    onCancel.dispose();
    await registry.dispose().catch(() => undefined);
  }

  lastGraph = { graph: result.graph, folder: workspaceFolder, generatedAt: Date.now() };

  const verified = countByVerification(result.graph, 'verified');
  const partial = countByVerification(result.graph, 'partial');
  const unverified = countByVerification(result.graph, 'unverified');

  response.markdown(
    [
      '',
      `**Done in ${(result.stats.durationMs / 1000).toFixed(1)}s.** ` +
        `${result.stats.classCount} classes, ${result.stats.methodCount} methods, ` +
        `${result.stats.methodEdgeCount} method edges, ${result.stats.classEdgeCount} class edges.`,
      `Verification: OK ${verified} verified / WARN ${partial} partial / MISS ${unverified} unverified.`,
      formatVerificationDigest(result.graph) ?? '',
      result.graph.rootIntent ? `\n_${result.graph.rootIntent}_` : '',
      result.graph.entryMethodIds.length > 0
        ? `Suggested entry: \`${result.graph.entryMethodIds[0]}\``
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  );

  if (result.warnings.length > 0) {
    const head = result.warnings.slice(0, 8).map((w) => `- ${w}`).join('\n');
    const tail =
      result.warnings.length > 8 ? `\n- _...and ${result.warnings.length - 8} more_` : '';
    response.markdown(`\n\n**Warnings:**\n${head}${tail}`);
  }

  showGraph(context, result.graph, `CodeMap -- ${workspaceFolder.name}`);
}

function countByVerification(
  graph: CodeMapGraph,
  state: 'verified' | 'partial' | 'unverified',
): number {
  let n = 0;
  for (const c of Object.values(graph.classes)) {
    if (c.verification === state) n++;
  }
  return n;
}

// -------------------------------------------------------------------------
//   /focus, /why, /explain, /entries -- cached graph readers
// -------------------------------------------------------------------------

async function handleFocus(
  context: vscode.ExtensionContext,
  intent: ChatIntent,
  response: vscode.ChatResponseStream,
): Promise<void> {
  if (!intent.target) {
    response.markdown('Usage: `@codemap /focus <Class>`.');
    return;
  }
  const cached = requireCachedGraph(response);
  if (!cached) return;
  const result = focusSubgraph(cached.graph, intent.target);
  response.markdown(result.markdown);
  if (result.subgraph) {
    showGraph(context, result.subgraph, `CodeMap -- focus ${intent.target}`);
  }
}

async function handleWhy(
  intent: ChatIntent,
  response: vscode.ChatResponseStream,
): Promise<void> {
  if (!intent.target) {
    response.markdown('Usage: `@codemap /why <Class>`.');
    return;
  }
  const cached = requireCachedGraph(response);
  if (!cached) return;
  const result = explainClass(cached.graph, intent.target);
  response.markdown(result.markdown);
}

async function handleExplain(response: vscode.ChatResponseStream): Promise<void> {
  const cached = requireCachedGraph(response);
  if (!cached) return;
  const result = explainUnverified(cached.graph);
  response.markdown(result.markdown);
}

async function handleEntries(response: vscode.ChatResponseStream): Promise<void> {
  const cached = requireCachedGraph(response);
  if (!cached) return;
  const result = listEntries(cached.graph);
  response.markdown(result.markdown);
}

async function handleEval(response: vscode.ChatResponseStream): Promise<void> {
  response.markdown(
    [
      '`/eval` is **deferred to Phase 3.4** (v2 scorer rewrite).',
      '',
      'The legacy scorer compared a class-level graph against a golden YAML. v2 emits ',
      'method edges plus a derived class-edge view; the scorer needs to be re-implemented ',
      'against both. Track the slice in `docs/plan/v4-plan.md` (Phase 3.4).',
    ].join('\n'),
  );
}

function requireCachedGraph(response: vscode.ChatResponseStream): CachedGraph | null {
  if (!lastGraph) {
    response.markdown(
      '_No cached graph._ Run `@codemap generate codemap` (or `@codemap /scope <path>`) first.',
    );
    return null;
  }
  return lastGraph;
}

// -------------------------------------------------------------------------
//   calibrator wiring
// -------------------------------------------------------------------------

interface LoadedCalibrators {
  csharp: boolean;
  typescript: boolean;
}

async function preloadCalibrators(
  folder: vscode.WorkspaceFolder,
  registry: CalibratorRegistry,
  response: vscode.ChatResponseStream,
): Promise<LoadedCalibrators> {
  const loaded: LoadedCalibrators = { csharp: false, typescript: false };

  const slnxUri = await findFirstFile(folder, ['**/*.slnx', '**/*.sln']);
  if (slnxUri) {
    try {
      const csharp = registry.getCalibrator('csharp');
      if (csharp instanceof CSharpCalibratorHost) {
        await csharp.start();
      }
      await csharp.loadSolution({ slnxPath: slnxUri.fsPath });
      loaded.csharp = true;
      response.markdown(`\nC# calibrator loaded: \`${vscode.workspace.asRelativePath(slnxUri, false)}\`\n`);
    } catch (e) {
      response.markdown(
        `\nWARN C# calibrator unavailable: ${(e as Error).message}. C# methods will stay unverified.\n`,
      );
    }
  }

  const tsConfigUri = await findFirstFile(folder, ['tsconfig.json', '**/tsconfig.json']);
  if (tsConfigUri) {
    try {
      const ts = registry.getCalibrator('typescript');
      await ts.loadSolution({ slnxPath: tsConfigUri.fsPath });
      loaded.typescript = true;
      response.markdown(
        `\nTypeScript calibrator loaded: \`${vscode.workspace.asRelativePath(tsConfigUri, false)}\`\n`,
      );
    } catch (e) {
      response.markdown(
        `\nWARN TypeScript calibrator unavailable: ${(e as Error).message}. TS/JS methods will stay unverified.\n`,
      );
    }
  }

  return loaded;
}

function calibratorForLang(
  lang: string,
  registry: CalibratorRegistry,
  loaded: LoadedCalibrators,
): CalibratorService | undefined {
  if (lang === 'csharp') return loaded.csharp ? registry.getCalibrator('csharp') : undefined;
  if (
    lang === 'typescript' ||
    lang === 'javascript' ||
    lang === 'typescriptreact' ||
    lang === 'javascriptreact'
  ) {
    return loaded.typescript ? registry.getCalibrator('typescript') : undefined;
  }
  return undefined;
}

async function findFirstFile(
  folder: vscode.WorkspaceFolder,
  patterns: readonly string[],
): Promise<vscode.Uri | undefined> {
  for (const pattern of patterns) {
    const rel = new vscode.RelativePattern(folder, pattern);
    const found = await vscode.workspace.findFiles(rel, '**/{node_modules,bin,obj,dist,out,.git}/**', 1);
    if (found.length > 0) return found[0];
  }
  return undefined;
}

function resolveCsharpExe(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  setting: string,
): string | undefined {
  if (setting && setting.trim().length > 0) {
    return path.isAbsolute(setting) ? setting : path.join(folder.uri.fsPath, setting);
  }
  return path.join(context.extensionPath, DEFAULT_CSHARP_EXE_REL);
}
