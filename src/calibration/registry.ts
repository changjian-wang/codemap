// Phase 2.8 -- CalibratorRegistry.
//
// Resolves a `languageId` (as reported by VS Code documents) to the
// `CalibratorService` implementation that knows how to analyze that
// language. Each call returns the *same* instance for the same language
// so the orchestrator can keep stateful sessions (loaded solutions /
// projects) across queries without re-spawning subprocesses.
//
// Lifecycle is implementation-specific (see CalibratorService doc): the
// registry creates instances lazily, but does not call `start()` on the
// C# host. Callers that need an initialized host must invoke `start()`
// themselves -- the registry only owns identity + caching.

import { CSharpCalibratorHost } from './host/csharp-host';
import type { CalibratorService } from './calibrator-service';
import { NullCalibrator } from './null-calibrator';
import { TypeScriptCalibrator } from './typescript-calibrator';

export type CalibratorKind = 'csharp' | 'typescript' | 'null';

export interface CalibratorRegistryOptions {
  /**
   * Absolute path to the .NET calibrator binary. Required when any
   * `csharp` document is going to be analyzed; if omitted, requests for
   * `csharp` fall back to NullCalibrator so the orchestrator degrades
   * gracefully instead of throwing in the middle of a chat turn.
   */
  csharpExecutable?: string;
  /** Optional working directory passed to the C# host. */
  csharpCwd?: string;
  /** Optional workspace root forwarded to `initialize`. */
  workspaceRoot?: string;
}

const TYPESCRIPT_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'typescriptreact',
  'javascriptreact',
]);

export function calibratorKindForLanguage(
  languageId: string,
  opts?: CalibratorRegistryOptions
): CalibratorKind {
  if (languageId === 'csharp') {
    return opts?.csharpExecutable ? 'csharp' : 'null';
  }
  if (TYPESCRIPT_LANGUAGES.has(languageId)) {
    return 'typescript';
  }
  return 'null';
}

export class CalibratorRegistry {
  private readonly opts: CalibratorRegistryOptions;
  private csharp: CSharpCalibratorHost | null = null;
  private typescript: TypeScriptCalibrator | null = null;
  private nullCalibrator: NullCalibrator | null = null;

  constructor(opts: CalibratorRegistryOptions = {}) {
    this.opts = opts;
  }

  getCalibrator(languageId: string): CalibratorService {
    const kind = calibratorKindForLanguage(languageId, this.opts);
    switch (kind) {
      case 'csharp':
        if (!this.csharp) {
          this.csharp = new CSharpCalibratorHost({
            executable: this.opts.csharpExecutable!,
            cwd: this.opts.csharpCwd,
            workspaceRoot: this.opts.workspaceRoot,
          });
        }
        return this.csharp;
      case 'typescript':
        if (!this.typescript) {
          this.typescript = new TypeScriptCalibrator();
        }
        return this.typescript;
      case 'null':
      default:
        if (!this.nullCalibrator) {
          this.nullCalibrator = new NullCalibrator();
        }
        return this.nullCalibrator;
    }
  }

  /** Dispose every cached calibrator. Idempotent. */
  async dispose(): Promise<void> {
    const all: Array<Promise<void>> = [];
    if (this.csharp) {
      all.push(this.csharp.dispose());
      this.csharp = null;
    }
    if (this.typescript) {
      all.push(this.typescript.dispose());
      this.typescript = null;
    }
    if (this.nullCalibrator) {
      all.push(this.nullCalibrator.dispose());
      this.nullCalibrator = null;
    }
    await Promise.all(all);
  }
}
