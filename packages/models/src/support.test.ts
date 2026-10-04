import { z } from "zod";
import { BudgetExceededError, defaultSpendGuard, SpendGuard } from "./budget.js";
import { extractJson } from "./json.js";
import { estimateTokens, ModelUnavailableError, StructuredOutputError } from "./types.js";
import { type RawCompletion, ValidatingWriter } from "./writers/base.js";
import { NoneWriter } from "./writers/none.js";

describe("errors and token estimates", () => {
  it("words attempts in the singular and plural", () => {
    expect(new StructuredOutputError(1, "x").message).toBe(
      "writer output did not match the schema after 1 attempt: x"
    );
    const two = new StructuredOutputError(2, "y");
    expect(two.message).toContain("after 2 attempts: y");
    expect(two.name).toBe("StructuredOutputError");
    expect(two.attempts).toBe(2);
    const u = new ModelUnavailableError("judge", "offline");
    expect(u.message).toBe("judge unavailable: offline");
    expect(u.name).toBe("ModelUnavailableError");
  });

  it("estimates tokens as JSON length over four, rounded up", () => {
    expect(estimateTokens("abc")).toBe(2); // '"abc"' is 5 chars
    expect(estimateTokens(null)).toBe(1);
  });
});

describe("extractJson edge cases", () => {
  it("handles arrays, escapes and unterminated values", () => {
    expect(extractJson("list: [1, [2, 3]] done")).toEqual([1, [2, 3]]);
    expect(extractJson('{"q":"a \\"quoted\\" }"}')).toEqual({ q: 'a "quoted" }' });
    expect(extractJson("```\n[true]\n```")).toEqual([true]);
    expect(() => extractJson('{"a": [1, 2')).toThrow(/unterminated JSON/);
  });
});

describe("SpendGuard edges", () => {
  it("charges the estimate when usage is missing and throws once over the limit", () => {
    const g = new SpendGuard(100, "evals");
    g.charge(undefined, 60);
    expect(g.spent).toBe(60);
    expect(g.calls).toBe(1);
    expect(() => g.charge(undefined, 50)).toThrow(BudgetExceededError);
    expect(g.remaining).toBe(0);
    const err = (() => {
      try {
        g.reserve(1);
      } catch (e) {
        return e as BudgetExceededError;
      }
    })();
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err?.label).toBe("evals");
    expect(err?.spent).toBe(111);
    expect(err?.limit).toBe(100);
  });

  it("ignores invalid budgets from the environment and shares one process guard", () => {
    expect(SpendGuard.fromEnv({ YNM_TOKEN_BUDGET: "-5" }).maxInputTokens).toBe(2_000_000);
    expect(SpendGuard.fromEnv({ YNM_TOKEN_BUDGET: "abc" }, 42).maxInputTokens).toBe(42);
    expect(SpendGuard.fromEnv({ OTHER: "7" }, 1, "OTHER").maxInputTokens).toBe(7);
    expect(defaultSpendGuard()).toBe(defaultSpendGuard());
  });
});

describe("NoneWriter", () => {
  it("always refuses to write", async () => {
    const w = new NoneWriter();
    expect(w.name).toBe("none");
    await expect(w.write({ instructions: "i", state: null, schema: z.string() })).rejects.toThrow(
      "writer unavailable: none configured (set dream.writer)"
    );
  });
});

describe("ValidatingWriter edges", () => {
  class Fixed extends ValidatingWriter {
    readonly name = "fixed";
    prompts: string[] = [];
    constructor(private readonly texts: string[]) {
      super();
    }
    protected async complete(prompt: string): Promise<RawCompletion> {
      this.prompts.push(prompt);
      return { text: this.texts[this.prompts.length - 1] ?? "", model: "fixed-model" };
    }
  }

  it("leaves usage undefined when completions report none and names root-level issues '$'", async () => {
    const schema = z.array(z.string()).min(2);
    const w = new Fixed(["no json here", '["a","b"]']);
    const r = await w.write({ instructions: "i", state: null, schema });
    expect(r).toEqual({ value: ["a", "b"], model: "fixed-model", usage: undefined });
    expect(w.prompts[1]).toContain("rejected: no JSON in output");
    const root = new Fixed(['["a"]', '["b"]']);
    await expect(root.write({ instructions: "i", state: null, schema })).rejects.toThrow(
      /after 2 attempts: \$: /
    );
  });
});
