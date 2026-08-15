/**
 * Minimal LLM client abstraction used by stage 6 (semantic synthesis).
 *
 * The PKR *format* is model-agnostic by design (PKR_SPEC.md §9) — this
 * interface is what keeps the *extractor's own* LLM call swappable too,
 * even though the MVP ships exactly one concrete backend
 * (ARCHITECTURE.md M1: "default Claude via API key env var"). Swapping
 * backends means adding a new class here, not touching synthesize.ts.
 */

export interface LlmCompletionParams {
  system: string;
  user: string;
  maxTokens?: number;
  /**
   * Thinking/output depth, where the backend supports it (Anthropic: GA,
   * no beta header). Lower effort costs less and — per Anthropic's own
   * guidance — makes the model scope its answer tightly to what was asked
   * rather than "going above and beyond", which is exactly what a bounded,
   * evidence-only extraction task wants. Not a quality/cost trade-off for
   * this kind of task; default "medium" if the backend ignores it.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface LlmClient {
  complete(params: LlmCompletionParams): Promise<string>;
}

export class LlmNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmNotConfiguredError";
  }
}
