// Phase 3.1 -- production LlmClient backed by vscode.lm.
//
// This is the only orchestrator file that imports vscode, so the rest of
// the pipeline stays unit-testable. The chat participant constructs one
// of these on each chat turn so the user's currently-picked Copilot model
// is used; the command-palette path falls back to selectChatModels by
// family.

import * as vscode from 'vscode';
import type { LlmClient, LlmStreamRequest } from './llm-client';

export interface VscodeLmClientOptions {
  /** When invoked from a chat participant, the user-picked model. */
  preferredModel?: vscode.LanguageModelChat;
  /** Fallback family for command-palette / batch flows. */
  fallbackFamily?: string;
  fallbackVendor?: string;
}

export class VscodeLmClient implements LlmClient {
  private readonly opts: VscodeLmClientOptions;

  constructor(opts: VscodeLmClientOptions = {}) {
    this.opts = opts;
  }

  private async resolveModel(): Promise<vscode.LanguageModelChat> {
    if (this.opts.preferredModel) {
      return this.opts.preferredModel;
    }
    const vendor = this.opts.fallbackVendor ?? 'copilot';
    const family = this.opts.fallbackFamily ?? 'gpt-4o';
    const models = await vscode.lm.selectChatModels({ vendor, family });
    if (models.length === 0) {
      throw new Error(
        `No language model available for vendor="${vendor}" family="${family}". ` +
          'Ensure GitHub Copilot is installed and signed in, or invoke from chat ' +
          'so a picked model is forwarded.'
      );
    }
    return models[0]!;
  }

  async *stream(req: LlmStreamRequest): AsyncIterable<string> {
    const model = await this.resolveModel();
    const tokenSource = new vscode.CancellationTokenSource();
    const onAbort = () => tokenSource.cancel();
    if (req.signal) {
      if (req.signal.aborted) {
        tokenSource.cancel();
      } else {
        req.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      const messages = [
        vscode.LanguageModelChatMessage.User(req.systemPrompt),
        vscode.LanguageModelChatMessage.User(req.userMessage),
      ];
      const response = await model.sendRequest(messages, {}, tokenSource.token);
      for await (const fragment of response.text) {
        if (tokenSource.token.isCancellationRequested) {
          return;
        }
        yield fragment;
      }
    } finally {
      if (req.signal) {
        req.signal.removeEventListener('abort', onAbort);
      }
      tokenSource.dispose();
    }
  }
}
