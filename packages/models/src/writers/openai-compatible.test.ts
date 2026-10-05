import { startMemoryTelemetry } from "@ynm/telemetry/testing";
import { z } from "zod";
import { BudgetExceededError, defaultSpendGuard, SpendGuard } from "../budget.js";
import { ModelUnavailableError } from "../types.js";
import { OpenAICompatibleWriter } from "./openai-compatible.js";

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function recording(reply: () => Response, seen: Seen[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return reply();
  }) as unknown as typeof fetch;
}

const req = { instructions: "i", state: {}, schema: z.object({ ok: z.boolean() }) };
const okReply = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
    status: 200,
  });

describe("OpenAICompatibleWriter options and error paths (fetch mocked)", () => {
  it("omits auth and the guard for a keyless local server, and can skip json_schema", async () => {
    const seen: Seen[] = [];
    const w = new OpenAICompatibleWriter({
      baseUrl: "http://localhost:11434/v1/",
      model: "local",
      useJsonSchema: false,
      guard: new SpendGuard(1),
      fetch: recording(okReply, seen),
    });
    const r = await w.write(req);
    expect(r).toEqual({ value: { ok: true }, model: "local", usage: undefined });
    expect(seen[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(seen[0]?.headers.Authorization).toBeUndefined();
    expect(seen[0]?.body.response_format).toBeUndefined();
    expect(seen[0]?.body.temperature).toBe(0);
  });

  it("sends the key as a bearer token and charges the guard with actual usage", async () => {
    const seen: Seen[] = [];
    const guard = new SpendGuard(1_000_000);
    const w = new OpenAICompatibleWriter({
      baseUrl: "https://api.example/v1",
      model: "gpt-x",
      apiKey: "fake-key",
      guard,
      fetch: recording(
        () =>
          new Response(
            JSON.stringify({
              model: "gpt-x-2026",
              choices: [{ message: { content: '{"ok":false}' } }],
              usage: { prompt_tokens: 321 },
            })
          ),
        seen
      ),
    });
    const r = await w.write({ ...req, schemaName: "verdict" });
    expect(seen[0]?.headers.Authorization).toBe("Bearer fake-key");
    const format = seen[0]?.body.response_format as { json_schema?: { name?: string } } | undefined;
    expect(format?.json_schema?.name).toBe("verdict");
    expect(r.model).toBe("gpt-x-2026");
    expect(r.usage).toEqual({ inputTokens: 321, outputTokens: 0 });
    expect(guard.spent).toBe(321);
  });

  it("uses the process guard when a key is set and none is given", async () => {
    const guard = defaultSpendGuard();
    const before = guard.calls;
    const w = new OpenAICompatibleWriter({
      baseUrl: "https://api.example/v1",
      model: "m",
      apiKey: "fake-key",
      fetch: recording(okReply, []),
    });
    await w.write(req);
    expect(guard.calls).toBe(before + 1);
  });

  it("refuses before calling out when the reservation crosses the budget", async () => {
    const seen: Seen[] = [];
    const w = new OpenAICompatibleWriter({
      baseUrl: "https://api.example/v1",
      model: "m",
      apiKey: "fake-key",
      guard: new SpendGuard(10),
      fetch: recording(okReply, seen),
    });
    await expect(w.write(req)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(seen).toHaveLength(0);
  });

  it("wraps network failures as unavailable, naming the endpoint", async () => {
    const w = new OpenAICompatibleWriter({
      baseUrl: "http://down/v1",
      model: "m",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const p = w.write(req);
    await expect(p).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(p).rejects.toThrow("openai-compatible (http://down/v1) unavailable: fetch failed");
  });

  it("reports HTTP errors with status and body", async () => {
    const w = new OpenAICompatibleWriter({
      baseUrl: "http://x/v1",
      model: "m",
      fetch: recording(() => new Response("model not found", { status: 404 }), []),
    });
    await expect(w.write(req)).rejects.toThrow(/unavailable: 404 model not found/);
  });

  it("treats a reply without choices as empty text and fails closed after a retry", async () => {
    const seen: Seen[] = [];
    const w = new OpenAICompatibleWriter({
      baseUrl: "http://x/v1",
      model: "m",
      fetch: recording(
        () => new Response(JSON.stringify({ usage: { completion_tokens: 4 } })),
        seen
      ),
    });
    await expect(w.write(req)).rejects.toThrow(/after 2 attempts: no JSON in output/);
    expect(seen).toHaveLength(2);
  });
});

describe("OpenAICompatibleWriter with telemetry on", () => {
  it("is one client span per request, whose trace headers the request carries", async () => {
    const t = await startMemoryTelemetry();
    try {
      const headers: Headers[] = [];
      const w = new OpenAICompatibleWriter({
        baseUrl: "http://localhost:11434/v1",
        model: "local",
        fetch: (async (_url: string | URL, init?: RequestInit) => {
          headers.push(new Headers(init?.headers));
          return okReply();
        }) as unknown as typeof fetch,
      });
      await w.write(req);
      const { spans } = await t.exported();
      const span = spans.find((s) => s.name === "model openai-compatible");
      expect(span?.attributes).toMatchObject({
        "ynm.model.provider": "openai-compatible",
        "gen_ai.request.model": "local",
      });
      expect(headers[0]?.get("traceparent")).toBe(`00-${span?.traceId}-${span?.spanId}-01`);
      expect(headers[0]?.get("content-type")).toBe("application/json");
    } finally {
      await t.stop();
    }
  });
});
