import { z } from "zod";
import {
  DreamConfigSchema,
  PurgeInputSchema,
  StoredJudgmentSchema,
  ThresholdSchema,
} from "./judgments.js";
import { MemoryRecordSchema } from "./record.js";

type JsonSchema = {
  description?: string;
  properties?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
};

function undescribed(schema: JsonSchema, prefix = ""): string[] {
  const out: string[] = [];
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    if (!prop.description) out.push(`${prefix}${name}`);
    out.push(...undescribed(prop, `${prefix}${name}.`));
  }
  return out;
}

describe("schema descriptions feed CLI, MCP and docs", () => {
  it("every dream config key has a description", () => {
    const json = z.toJSONSchema(DreamConfigSchema, { io: "input" }) as JsonSchema;
    expect(undescribed(json)).toEqual([]);
  });
  it("op, tags and links on a record have descriptions", () => {
    const json = z.toJSONSchema(MemoryRecordSchema, { io: "input" }) as JsonSchema;
    for (const key of ["op", "tags", "links"]) {
      expect(json.properties?.[key]?.description, key).toBeTruthy();
    }
  });
});

describe("DreamConfigSchema", () => {
  it("fills every default from an empty object", () => {
    const c = DreamConfigSchema.parse({});
    expect(c.judge).toBe("auto");
    expect(c.writer).toBe("auto");
    expect(c.thresholds.dedupe).toEqual({ act: 0.85, review: 0.6 });
    expect(c.thresholds.promote).toEqual({ act: 0.7, review: 0.5 });
    expect(c.thresholds.reflect).toEqual({ minEpisodes: 3, flagAt: 0.7 });
    expect(c.typesafe.apiKeyEnv).toBe("TYPESAFE_API_KEY");
    expect(c.openai.baseUrl).toBe("http://localhost:11434/v1");
  });
  it("accepts a review threshold equal to or below act", () => {
    expect(
      ThresholdSchema.safeParse({ act: 0.8, review: 0.8 }).success &&
        ThresholdSchema.safeParse({ act: 0.9, review: 0.1 }).success
    ).toBe(true);
  });
  it("rejects a review threshold above act with a readable message", () => {
    const r = DreamConfigSchema.safeParse({ thresholds: { dedupe: { act: 0.5, review: 0.9 } } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe("review threshold must not exceed act threshold");
  });
  it("rejects thresholds outside [0, 1] and unknown keys", () => {
    expect(ThresholdSchema.safeParse({ act: 1.2, review: 0.5 }).success).toBe(false);
    expect(DreamConfigSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });
});

describe("StoredJudgmentSchema", () => {
  it("parses a judgment with optional band and usage", () => {
    const j = {
      pass: "dedupe",
      model: "heuristic",
      calibrated: false,
      at: "2026-01-01T00:00:00.000Z",
      questions: { same: "Are these the same?" },
      answers: { same: 0.9 },
      band: "act",
      usage: { inputTokens: 10, outputTokens: 2 },
    };
    expect(StoredJudgmentSchema.parse(j)).toEqual(j);
    expect(StoredJudgmentSchema.safeParse({ ...j, band: "maybe" }).success).toBe(false);
  });
});

describe("PurgeInputSchema", () => {
  it("needs a reason and keeps ref history by default", () => {
    expect(PurgeInputSchema.parse({ memoryId: "m1", reason: "leaked secret" })).toEqual({
      memoryId: "m1",
      reason: "leaked secret",
      forgetHistory: false,
    });
    expect(PurgeInputSchema.safeParse({ memoryId: "m1", reason: "" }).success).toBe(false);
    expect(PurgeInputSchema.safeParse({ memoryId: "m1", reason: "x".repeat(1001) }).success).toBe(
      false
    );
  });
});
