// Phase 3.1 -- LlmClient abstraction.
//
// The orchestrator uses an LLM to extract v2 ClassNode / MethodNode shape
// from source files. This interface narrows the surface to "stream me a
// completion" so the analyzer is fully unit-testable with a MockLlmClient
// that yields pre-recorded fragments. The production implementation that
// actually calls vscode.lm lives in vscode-lm-client.ts and is wired in
// by the chat participant; the rest of the orchestrator never imports
// the vscode module.

export interface LlmStreamRequest {
  systemPrompt: string;
  userMessage: string;
  /** Aborts the stream when fired. Implementations must stop yielding. */
  signal?: AbortSignal;
}

export interface LlmClient {
  /**
   * Stream a single-turn completion as text fragments. The async iterator
   * must terminate (return) when `signal` is aborted; thrown errors
   * propagate to the caller.
   */
  stream(req: LlmStreamRequest): AsyncIterable<string>;
}
