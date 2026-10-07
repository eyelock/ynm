import { defaultSpendGuard, type SpendGuard } from "../budget.js";
import { modelCall } from "../telemetry.js";
import {
  type Answer,
  estimateTokens,
  type JsonValue,
  type Judge,
  type JudgeLimits,
  type Judgment,
  ModelUnavailableError,
  type Question,
} from "../types.js";

export interface TypeSafeOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Hard cap on input tokens this judge may spend; defaults to the process guard. */
  guard?: SpendGuard;
}

/** Jev 1.13 limits from https://docs.typesafe.ai/models */
export const JEV_LIMITS: JudgeLimits = {
  stateTokens: 32_000,
  requestTokens: 64_000,
  maxChoices: 255,
};

/**
 * TypeSafe System One judge, built to the documented HTTP contract
 * (POST /v1/systemone; https://docs.typesafe.ai/api). Calibrated probabilities (ADR-012).
 */
export class TypeSafeJudge implements Judge {
  readonly name = "typesafe";
  readonly calibrated = true;
  readonly guard: SpendGuard;
  constructor(private readonly opts: TypeSafeOptions) {
    if (!opts.apiKey) throw new ModelUnavailableError("typesafe", "no API key (TYPESAFE_API_KEY)");
    this.guard = opts.guard ?? defaultSpendGuard();
  }

  limits(): JudgeLimits {
    return JEV_LIMITS;
  }

  async judge<Q extends Record<string, Question>>(
    state: JsonValue,
    questions: Q
  ): Promise<Judgment<Q>> {
    if (estimateTokens(state) > JEV_LIMITS.stateTokens)
      throw new Error(
        `state exceeds ${JEV_LIMITS.stateTokens} tokens; trim it in code before judging`
      );
    const estimate = estimateTokens(state) + estimateTokens(questions as unknown as JsonValue);
    this.guard.reserve(estimate);
    const f = this.opts.fetch ?? fetch;
    const model = this.opts.model ?? "jev-latest";
    let res: Response;
    try {
      // One client span per request (ADR-018); never the state or the answers.
      res = await modelCall("typesafe", model, undefined, async (span) => {
        const r = await f(
          `${(this.opts.baseUrl ?? "https://api.typesafe.ai").replace(/\/$/, "")}/v1/systemone`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.opts.apiKey}`,
            },
            body: JSON.stringify({ state, model, questions }),
            signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
          }
        );
        if (!r.ok) span.outcome("error", String(r.status));
        return r;
      });
    } catch (e) {
      throw new ModelUnavailableError("typesafe", (e as Error).message);
    }
    if (res.status === 429 || res.status === 529)
      throw new ModelUnavailableError(
        "typesafe",
        `${res.status} rate limited or overloaded; retry with backoff`
      );
    if (!res.ok) throw new ModelUnavailableError("typesafe", `${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      model: string;
      answers: Record<string, Answer>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const usage = data.usage
      ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 }
      : undefined;
    this.guard.charge(usage, estimate);
    const answers = {} as { [K in keyof Q]: Answer };
    for (const id of Object.keys(questions) as Array<keyof Q>) {
      const a = data.answers[id as string];
      if (!a) throw new Error(`typesafe answer missing for question ${String(id)}`);
      answers[id] = a;
    }
    return {
      answers,
      model: data.model,
      calibrated: true,
      usage,
    };
  }
}
