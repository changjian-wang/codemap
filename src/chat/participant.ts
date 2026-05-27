import * as vscode from 'vscode';

// Phase 0.1 stub — every @codemap interaction returns the rebuild
// notice. The full intent router (scope / focus / why / explain /
// eval / entries) will be re-wired in Phase 3.3 once the new
// orchestrator + Pixi renderer + calibrator host are in place.
// See docs/adrs/005-renderer-rewrite-pixi.md and
// docs/plan/v4-plan.md.

const REBUILD_MARKDOWN = [
  '**CodeMap v0.1.0 — under reconstruction**',
  '',
  'The orchestrator, calibrator, and webview are being rewritten:',
  '',
  '- Renderer → Pixi.js + custom d3-force / ELK layout',
  '- C# calibrator → Roslyn (`MSBuildWorkspace`) via a dotnet-tool subprocess',
  '- TS/JS calibrator → TypeScript Compiler API + ts-morph, in-process',
  '- All language calibrators expose the same `CalibratorService` interface',
  '',
  'Track the slice plan in `docs/plan/v4-plan.md`. Decisions are pinned in `docs/adrs/005-renderer-rewrite-pixi.md`.',
].join('\n');

export function registerChatParticipant(_context: vscode.ExtensionContext): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(
    'codemap.codemap',
    async (_request, _ctx, stream, _token) => {
      stream.markdown(REBUILD_MARKDOWN);
    },
  );
  return participant;
}
