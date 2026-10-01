import { BudgetExceededError, SpendGuard } from "../budget.js";
import { ModelUnavailableError } from "../types.js";
import { JEV_LIMITS, TypeSafeJudge } from "./typesafe.js";

const q = { q: { type: "noul" as const, instructions: "?" } };

function respond(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch;
}

describe("TypeSafeJudge error paths and options (fetch mocked)", () => {
  it("reports Jev limits", () => {
    const j = new TypeSafeJudge({
      apiKey: "fake-key",
      fetch: respond({}),
      guard: new SpendGuard(10),
    });
    expect(j.limits()).toBe(JEV_LIMITS);
    expect(j.name).toBe("typesafe");
  });

  it("falls back to the process guard when none is given", () => {
    const a = new TypeSafeJudge({ apiKey: "fake-key" });
    const b = new TypeSafeJudge({ apiKey: "fake-key" });
    expect(a.guard).toBeInstanceOf(SpendGuard);
    expect(a.guard).toBe(b.guard);
  });

  it("refuses an oversized state before calling out", async () => {
    let called = false;
    const j = new TypeSafeJudge({
      apiKey: "fake-key",
      guard: new SpendGuard(10_000_000),
      fetch: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    const big = "x".repeat(JEV_LIMITS.stateTokens * 4 + 8);
    await expect(j.judge(big, q)).rejects.toThrow(/state exceeds 32000 tokens/);
    expect(called).toBe(false);
  });

  it("refuses when the reservation would cross the budget, without calling out", async () => {
    let called = false;
    const j = new TypeSafeJudge({
      apiKey: "fake-key",
      guard: new SpendGuard(5),
      fetch: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    await expect(j.judge({ a: "some state" }, q)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(called).toBe(false);
  });

  it("wraps network failures and timeouts as unavailable", async () => {
    const j = new TypeSafeJudge({
      apiKey: "fake-key",
      guard: new SpendGuard(1_000_000),
      fetch: (async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }) as unknown as typeof fetch,
    });
    const p = j.judge({}, q);
    await expect(p).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(p).rejects.toThrow(/typesafe unavailable: .*timeout/);
  });

  it("treats 529 as overloaded and other HTTP errors with their body", async () => {
    const guard = new SpendGuard(1_000_000);
    const overloaded = new TypeSafeJudge({
      apiKey: "fake-key",
      guard,
      fetch: respond("busy", 529),
    });
    await expect(overloaded.judge({}, q)).rejects.toThrow(/529 rate limited or overloaded/);
    const broken = new TypeSafeJudge({
      apiKey: "fake-key",
      guard,
      fetch: respond("bad question", 400),
    });
    await expect(broken.judge({}, q)).rejects.toThrow(/typesafe unavailable: 400 bad question/);
    expect(guard.spent).toBe(0);
  });

  it("charges the estimate when the reply carries no usage, and leaves usage undefined", async () => {
    const guard = new SpendGuard(1_000_000);
    const j = new TypeSafeJudge({
      apiKey: "fake-key",
      guard,
      fetch: respond({ model: "jev", answers: { q: { type: "noul", noul: 0.3 } } }),
    });
    const r = await j.judge({ a: "x" }, q);
    expect(r.usage).toBeUndefined();
    expect(r.model).toBe("jev");
    expect(guard.spent).toBeGreaterThan(0);
    expect(guard.calls).toBe(1);
  });

  it("defaults missing usage counts to zero", async () => {
    const j = new TypeSafeJudge({
      apiKey: "fake-key",
      guard: new SpendGuard(1_000_000),
      fetch: respond({ model: "jev", answers: { q: { type: "noul", noul: 0.3 } }, usage: {} }),
    });
    const r = await j.judge({}, q);
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("throws when an answer is missing for a question", async () => {
    const j = new TypeSafeJudge({
      apiKey: "fake-key",
      guard: new SpendGuard(1_000_000),
      fetch: respond({ model: "jev", answers: {} }),
    });
    await expect(j.judge({}, q)).rejects.toThrow(/typesafe answer missing for question q/);
  });

  it("honours a custom base URL (trailing slash trimmed) and model", async () => {
    let seen: { url: string; model: string } | undefined;
    const j = new TypeSafeJudge({
      apiKey: "fake-key",
      model: "jev-1.13.0",
      baseUrl: "https://proxy.example/",
      guard: new SpendGuard(1_000_000),
      fetch: (async (url: string | URL, init?: RequestInit) => {
        seen = {
          url: String(url),
          model: (JSON.parse(String(init?.body)) as { model: string }).model,
        };
        return new Response(
          JSON.stringify({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 1 } } })
        );
      }) as unknown as typeof fetch,
    });
    await j.judge({}, q);
    expect(seen).toEqual({ url: "https://proxy.example/v1/systemone", model: "jev-1.13.0" });
  });
});
