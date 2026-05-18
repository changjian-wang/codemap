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

/**
 * VS Code LM client that prefers a caller-supplied model instance — when
 * invoked from a Chat Participant we use `request.model`, which is the model
 * the user picked in the Copilot Chat picker. As a fallback (e.g. command
 * palette) we look up by `family`.
 */
export class VscodeLmClient implements LlmClient {
  constructor(
    private fallbackFamily: string,
    private preferredModel?: vscode.LanguageModelChat,
  ) {}

  /** The model that will actually be used for the next stream() call. */
  async resolveModel(): Promise<vscode.LanguageModelChat> {
    if (this.preferredModel) return this.preferredModel;
    const models = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: this.fallbackFamily,
    });
    if (models.length === 0) {
      throw new Error(
        `No Copilot model available for family "${this.fallbackFamily}". ` +
          `Ensure GitHub Copilot is installed and signed in, ` +
          `or invoke @codemap from Copilot Chat so the picked model is used.`,
      );
    }
    return models[0]!;
  }

  async *stream(
    systemPrompt: string,
    userMessage: string,
    token: vscode.CancellationToken,
  ): AsyncGenerator<string, void, void> {
    const model = await this.resolveModel();
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
