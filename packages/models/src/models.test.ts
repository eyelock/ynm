import { z } from "zod";
import { resolveModels } from "./factory.js";
import { extractJson } from "./json.js";
import { HeuristicJudge, jaccard } from "./judges/heuristic.js";
import { TypeSafeJudge } from "./judges/typesafe.js";
import { WriterEmulatedJudge } from "./judges/writer-emulated.js";
import { StructuredOutputError, type Writer } from "./types.js";
import { type RawCompletion, ValidatingWriter } from "./writers/base.js";
import { OpenAICompatibleWriter } from "./writers/openai-compatible.js";

class ScriptedWriter extends ValidatingWriter {
  readonly name = "scripted";
  calls = 0;
  constructor(private readonly outputs: string[]) {
    super();
  }
  protected async complete(): Promise<RawCompletion> {
    const text = this.outputs[Math.min(this.calls, this.outputs.length - 1)] ?? "";
    this.calls += 1;
    return { text, model: "scripted", usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

describe("extractJson", () => {
  it("finds JSON inside fences and prose", () => {
    expect(extractJson('Sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('text {"a":"}"} tail')).toEqual({ a: "}" });
    expect(() => extractJson("nothing")).toThrow(/no JSON/);
  });
});

describe("ValidatingWriter (ADR-012 fail closed)", () => {
  const schema = z.object({ summary: z.string().min(1), count: z.number().int() });
  it("validates, retries once with the issues, then rejects", async () => {
    const good = new ScriptedWriter([
      '{"summary":"x","count":"nope"}',
      '{"summary":"x","count":2}',
    ]);
    const r = await good.write({ instructions: "do", state: { a: 1 }, schema });
    expect(r.value).toEqual({ summary: "x", count: 2 });
    expect(good.calls).toBe(2);
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    const bad = new ScriptedWriter(["not json", '{"count": 1}']);
    await expect(bad.write({ instructions: "do", state: null, schema })).rejects.toBeInstanceOf(
      StructuredOutputError
    );
  });
});

describe("HeuristicJudge", () => {
  const j = new HeuristicJudge();
  it("computes similarity-based answers for the known question ids", async () => {
    const r = await j.judge(
      {
        a: "Notes are anchored to the root commit of the repo",
        b: "Notes are anchored to the root commit",
      },
      {
        sameFact: { type: "noul", instructions: "same?" },
        relation: {
          type: "score",
          instructions: "relation",
          criteria: ["different", "related", "same"],
        },
        contradicts: { type: "noul", instructions: "c" },
      }
    );
    expect(r.calibrated).toBe(false);
    expect((r.answers.sameFact as { noul: number }).noul).toBeGreaterThan(0.6);
    expect((r.answers.relation as { score: number }).score).toBe(2);
    expect((r.answers.contradicts as { noul: number }).noul).toBeLessThan(0.2);
    const c = await j.judge(
      { a: "the deploy target is blue", b: "the deploy target is not blue" },
      { contradicts: { type: "noul", instructions: "c" } }
    );
    expect((c.answers.contradicts as { noul: number }).noul).toBeGreaterThan(0.7);
    expect(jaccard("", "x")).toBe(0);
  });
  it("answers unknown questions with honest uncertainty", async () => {
    const r = await j.judge(
      {},
      {
        whatever: { type: "noul", instructions: "?" },
        pick: { type: "choice", instructions: "?", criteria: { x: null, y: null } },
      }
    );
    expect((r.answers.whatever as { noul: number }).noul).toBe(0.5);
    expect((r.answers.pick as { confidence: number }).confidence).toBe(0);
  });
});

describe("TypeSafeJudge (mocked contract)", () => {
  it("posts state and questions and maps answers", async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const fetchMock = (async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: ((init?.headers ?? {}) as Record<string, string>).Authorization ?? null,
      });
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { same: { type: "noul", noul: 0.91 } },
          usage: { input_tokens: 120, output_tokens: 0 },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const j = new TypeSafeJudge({ apiKey: "k", fetch: fetchMock });
    const r = await j.judge({ a: "x", b: "y" }, { same: { type: "noul", instructions: "same?" } });
    const first = calls[0];
    expect(first?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(first?.auth).toBe("Bearer k");
    expect((first?.body as { model: string } | undefined)?.model).toBe("jev-latest");
    expect(r.calibrated).toBe(true);
    expect((r.answers.same as { noul: number }).noul).toBe(0.91);
    expect(r.usage?.inputTokens).toBe(120);
  });
  it("refuses without a key and surfaces rate limits", async () => {
    expect(() => new TypeSafeJudge({ apiKey: "" })).toThrow(/no API key/);
    const j = new TypeSafeJudge({
      apiKey: "k",
      fetch: (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch,
    });
    await expect(j.judge({}, { q: { type: "noul", instructions: "?" } })).rejects.toThrow(/429/);
  });
});

describe("SpendGuard (hard cap on paid usage)", () => {
  it("refuses a call that would cross the budget and charges actual usage", async () => {
    const { SpendGuard, BudgetExceededError } = await import("./budget.js");
    const guard = new SpendGuard(1000, "test");
    guard.reserve(400);
    guard.charge({ inputTokens: 450, outputTokens: 10 });
    expect(guard.remaining).toBe(550);
    expect(() => guard.reserve(600)).toThrow(BudgetExceededError);
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          model: "jev",
          answers: { q: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 700, output_tokens: 0 },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const j = new TypeSafeJudge({ apiKey: "k", fetch: fetchMock, guard });
    await expect(j.judge({ a: "x" }, { q: { type: "noul", instructions: "?" } })).rejects.toThrow(
      /budget exceeded/
    );
    expect(SpendGuard.fromEnv({ YNM_TOKEN_BUDGET: "123" }).maxInputTokens).toBe(123);
    expect(SpendGuard.fromEnv({}).maxInputTokens).toBe(2_000_000);
  });

  it("charges the estimate when usage is missing or reports no input tokens", async () => {
    const { SpendGuard } = await import("./budget.js");
    const guard = new SpendGuard(1000, "test");
    guard.charge(undefined, 30);
    guard.charge({ inputTokens: 0, outputTokens: 12 }, 40);
    guard.charge({ inputTokens: 25, outputTokens: 0 }, 40);
    expect(guard.spent).toBe(95);
    expect(guard.calls).toBe(3);
  });

  it("counts a TypeSafe call whose reply leaves out input_tokens", async () => {
    const { SpendGuard } = await import("./budget.js");
    const guard = new SpendGuard(1000, "test");
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          model: "jev",
          answers: { q: { type: "noul", noul: 0.5 } },
          usage: { output_tokens: 4 },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const j = new TypeSafeJudge({ apiKey: "fake-key", fetch: fetchMock, guard });
    await j.judge({ a: "x" }, { q: { type: "noul", instructions: "?" } });
    expect(guard.calls).toBe(1);
    expect(guard.spent).toBeGreaterThan(0);
  });

  it("counts an OpenAI-compatible call whose reply has only completion_tokens", async () => {
    const { SpendGuard, BudgetExceededError } = await import("./budget.js");
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          model: "gpt",
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { completion_tokens: 3 },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const guard = new SpendGuard(1000, "test");
    const w = new OpenAICompatibleWriter({
      baseUrl: "http://paid.invalid/v1",
      model: "gpt",
      apiKey: "fake-key",
      fetch: fetchMock,
      guard,
    });
    const req = { instructions: "say ok", state: {}, schema: z.object({ ok: z.boolean() }) };
    await w.write(req);
    expect(guard.spent).toBeGreaterThan(0);
    // Repeated calls that never report input tokens must still reach the cap.
    await expect(
      (async () => {
        for (let i = 0; i < 20; i++) await w.write(req);
      })()
    ).rejects.toThrow(BudgetExceededError);
  });
});

describe("WriterEmulatedJudge", () => {
  it("turns a writer's JSON into answers marked uncalibrated", async () => {
    const writer: Writer = {
      name: "fake",
      write: async () => ({
        value: {
          same: { noul: 0.8 },
          kind: { choice: "b", confidence: 0.9 },
          level: { score: 2, confidence: 0.7 },
        },
        model: "fake",
      }),
    };
    const j = new WriterEmulatedJudge(writer);
    const r = await j.judge(
      {},
      {
        same: { type: "noul", instructions: "?" },
        kind: { type: "choice", instructions: "?", criteria: { a: null, b: null } },
        level: { type: "score", instructions: "?", criteria: ["lo", "mid", "hi"] },
      }
    );
    expect(r.calibrated).toBe(false);
    expect(
      (r.answers.kind as { choice: string; probabilities: Record<string, number> }).probabilities.b
    ).toBe(0.9);
    expect((r.answers.level as { score: number }).score).toBe(2);
  });
});

describe("OpenAICompatibleWriter", () => {
  it("calls chat/completions with json_schema and validates the reply", async () => {
    const fetchMock = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { response_format?: { type: string } };
      expect(body.response_format?.type).toBe("json_schema");
      return new Response(
        JSON.stringify({
          model: "qwen3",
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const w = new OpenAICompatibleWriter({
      baseUrl: "http://x/v1",
      model: "qwen3",
      fetch: fetchMock,
    });
    const r = await w.write({
      instructions: "i",
      state: {},
      schema: z.object({ ok: z.boolean() }),
    });
    expect(r.value.ok).toBe(true);
    expect(r.model).toBe("qwen3");
  });
});

describe("resolveModels", () => {
  it("names the configured key variable in the resolution reason", () => {
    const r = resolveModels(
      { judge: "auto", writer: "none", typesafe: { apiKeyEnv: "MY_JUDGE_KEY" } },
      { MY_JUDGE_KEY: "k" }
    );
    expect(r.resolution.judge).toBe("auto: MY_JUDGE_KEY present");
  });
  it("prefers typesafe with a key, emulates over a writer, else heuristic", () => {
    expect(resolveModels(undefined, { TYPESAFE_API_KEY: "k" }).judge.name).toBe("typesafe");
    const emulated = resolveModels(undefined, {}, { claudeCli: true });
    expect(emulated.judge.name).toBe("writer-emulated:claude-cli");
    const none = resolveModels(undefined, {});
    expect(none.judge.name).toBe("heuristic");
    expect(none.writer.name).toBe("none");
    expect(resolveModels({ judge: "heuristic", writer: "openai-compatible" }, {}).writer.name).toBe(
      "openai-compatible"
    );
  });
});
