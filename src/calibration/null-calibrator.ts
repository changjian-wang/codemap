// Phase 2.8 -- fallback calibrator for languages we do not yet support
// (or for environments where the real calibrator cannot be configured).
// Returns empty callee lists and a load-solution stub. Callers should
// treat NullCalibrator output as `unverified` -- the registry surfaces
// the calibrator identity so the orchestrator can attach that label.

import type {
  LoadSolutionParams,
  LoadSolutionResult,
  ResolveCalleesParams,
  ResolveCalleesResult,
} from '../shared/calibrator-protocol';
import type { CalibratorService } from './calibrator-service';

export class NullCalibrator implements CalibratorService {
  async loadSolution(params: LoadSolutionParams): Promise<LoadSolutionResult> {
    return {
      slnxPath: params.slnxPath,
      declaredProjectCount: 0,
      loadedProjectCount: 0,
      distinctProjectCount: 0,
      projects: [],
      skipped: [],
      diagnostics: ['NullCalibrator -- language not supported; results are unverified'],
      elapsedMs: 0,
    };
  }

  async resolveCallees(params: ResolveCalleesParams): Promise<ResolveCalleesResult> {
    return {
      filePath: params.filePath,
      classId: params.classId,
      methodName: params.methodName,
      methodFullyQualifiedName: params.classId
        ? `${params.classId}.${params.methodName}`
        : params.methodName,
      callees: [],
      elapsedMs: 0,
    };
  }

  async dispose(): Promise<void> {
    // nothing to release
  }
}
