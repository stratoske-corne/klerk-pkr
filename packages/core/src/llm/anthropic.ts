/**
 * Default LLM backend for stage 6. One concrete implementation of
 * `LlmClient` (client.ts) — the extraction pipeline never imports the
 * Anthropic SDK directly, only this class, so swapping backends later
 * doesn't touch synthesize.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import { LlmNotConfiguredError, type LlmClient, type LlmCompletionParams } from "./client.js";

const DEFAULT_MODEL = "claude-sonnet-5";

export interface AnthropicLlmClientOptions {
  apiKey?: string;
  model?: string;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicLlmClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new LlmNotConfiguredError(
        "ANTHROPIC_API_KEY is not set. Set it in your environment, or pass --no-llm to `pkr export` " +
          "to skip semantic synthesis (stage 6) and export deterministic knowledge only.",
      );
    }
    this.client = new Anthropic({ apiKey });
    this.model = options.model ?? process.env.PKR_LLM_MODEL ?? DEFAULT_MODEL;
  }

  async complete({ system, user, maxTokens = 4096, effort = "medium" }: LlmCompletionParams): Promise<string> {
    // Prompt caching (no beta header, GA): marking the system block and the
    // (often large) user block cacheable costs nothing when the prefix is
    // below the model's cacheable minimum or never repeats — it just silently
    // doesn't cache. It pays off automatically on repeated calls with an
    // identical prefix (re-running `pkr export` on the same repo during
    // iteration, or a burst of calls within the ~5min TTL), at ~0.1x the
    // input price for the cached portion. See PKR-CLI docs / prompt-caching.
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      output_config: { effort },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: user, cache_control: { type: "ephemeral" } }] }],
    });
    const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === "text");
    return textBlock?.text ?? "";
  }
}

/** Returns a client if ANTHROPIC_API_KEY is set, otherwise null (never throws) — for callers that want to skip gracefully. */
export function tryCreateDefaultLlmClient(options: AnthropicLlmClientOptions = {}): AnthropicLlmClient | null {
  if (!(options.apiKey ?? process.env.ANTHROPIC_API_KEY)) return null;
  return new AnthropicLlmClient(options);
}
