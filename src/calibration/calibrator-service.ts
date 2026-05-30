// Phase 2.6 -- shared interface every CalibratorService implementation
// satisfies. Lets the orchestrator (and the upcoming registry in 2.8)
// treat the C# subprocess host and the in-process ts-morph calibrator
// interchangeably.
//
// We deliberately keep the surface narrow: lifecycle (start / dispose)
// is implementation-specific (the subprocess host needs spawn handshake,
// the in-process one doesn't) and is NOT part of this interface. Only
// the operations callers care about live here.

import type {
  LoadSolutionParams,
  LoadSolutionResult,
  ResolveCalleesParams,
  ResolveCalleesResult,
} from '../shared/calibrator-protocol';

export interface CalibratorService {
  /**
   * Load the analyzer's project graph. For C# this is a .slnx; for TS
   * the same `slnxPath` field is treated as a tsconfig.json path (or a
   * directory containing one). Naming reflects the wire protocol; the
   * TS implementation tolerates both meanings.
   */
  loadSolution(params: LoadSolutionParams): Promise<LoadSolutionResult>;

  /** Resolve callees of a method declaration in a previously loaded project. */
  resolveCallees(params: ResolveCalleesParams): Promise<ResolveCalleesResult>;

  /** Release any held resources. Idempotent. */
  dispose(): Promise<void>;
}
