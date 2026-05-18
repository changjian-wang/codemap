import * as vscode from 'vscode';

/**
 * Thin wrapper around vscode.lm so the orchestrator can request a streamed
 * completion without knowing the API surface, and so tests can stub the
 * model interaction by passing a different {@link LlmClient} implementation.
 */
export interface LlmClient {
  /**
   * Stream a single-turn completion. Yields text fragments as they arrive.
   * Implementations must respect `token` for cancellation.
   */
  stream(
    systemPrompt: string,
    userMessage: string,
    token: vscode.CancellationToken,
  ): AsyncGenerator<string, void, void>;
}

export class VscodeLmClient implements LlmClient {
  constructor(private preferredFamily: string) {}

  async *stream(
    systemPrompt: string,
    userMessage: string,
    token: vscode.CancellationToken,
  ): AsyncGenerator<string, void, void> {
    const models = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: this.preferredFamily,
    });
    if (models.length === 0) {
      throw new Error(
        `No Copilot model available for family "${this.preferredFamily}". ` +
          `Ensure GitHub Copilot is installed and signed in.`,
      );
    }
    const model = models[0]!;

    const messages = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
      vscode.LanguageModelChatMessage.User(userMessage),
    ];

    const response = await model.sendRequest(messages, {}, token);
    for await (const fragment of response.text) {
      if (token.isCancellationRequested) return;
      yield fragment;
    }
  }
}
