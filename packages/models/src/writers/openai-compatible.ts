import { defaultSpendGuard, type SpendGuard } from "../budget.js";
import { ModelUnavailableError } from "../types.js";
import { type RawCompletion, ValidatingWriter } from "./base.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Ask the server for JSON-schema constrained output; falls back to plain JSON mode. */
  useJsonSchema?: boolean;
  /** Hard cap on input tokens; only enforced when an API key is set (a local server is free). */
  guard?: SpendGuard;
}

/** Writer for any OpenAI-compatible chat endpoint: Ollama, vLLM, OpenAI, Groq and the like. */
export class OpenAICompatibleWriter extends ValidatingWriter {
  readonly name = "openai-compatible";
  constructor(private readonly opts: OpenAICompatibleOptions) {
    super();
  }

  protected async complete(
    prompt: string,
    jsonSchema: Record<string, unknown>,
    schemaName: string
  ): Promise<RawCompletion> {
    const guard = this.opts.apiKey ? (this.opts.guard ?? defaultSpendGuard()) : undefined;
    const estimate = Math.ceil(prompt.length / 4) + 200;
    guard?.reserve(estimate);
    const f = this.opts.fetch ?? fetch;
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    };
    if (this.opts.useJsonSchema ?? true)
      body.response_format = {
        type: "json_schema",
        json_schema: { name: schemaName, schema: jsonSchema },
      };
    let res: Response;
    try {
      res = await f(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
      });
    } catch (e) {
      throw new ModelUnavailableError(
        `openai-compatible (${this.opts.baseUrl})`,
        (e as Error).message
      );
    }
    if (!res.ok)
      throw new ModelUnavailableError(
        `openai-compatible (${this.opts.baseUrl})`,
        `${res.status} ${await res.text()}`
      );
    const data = (await res.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const usage = data.usage
      ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
        }
      : undefined;
    guard?.charge(usage, estimate);
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      model: data.model ?? this.opts.model,
      usage,
    };
  }
}
