import { z } from "zod";

/** A stored model decision, kept as `annotate` data so weights can change without re-inference (ADR-012). */
export const StoredJudgmentSchema = z.object({
  pass: z.string().describe("Dream pass that asked"),
  model: z.string(),
  calibrated: z.boolean(),
  at: z.string(),
  questions: z.record(z.string(), z.unknown()),
  answers: z.record(z.string(), z.unknown()),
  band: z.enum(["act", "review", "ignore"]).optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
});
export type StoredJudgment = z.infer<typeof StoredJudgmentSchema>;

export const ThresholdSchema = z
  .object({ act: z.number().min(0).max(1), review: z.number().min(0).max(1) })
  .refine((t) => t.review <= t.act, "review threshold must not exceed act threshold");

/** Confidence bands per pass (ADR-012): act automatically, act and flag, or queue for review. */
export const DreamConfigSchema = z
  .object({
    judge: z.enum(["auto", "heuristic", "typesafe", "writer-emulated"]).default("auto"),
    writer: z.enum(["auto", "none", "claude-cli", "openai-compatible"]).default("auto"),
    judgeOnWrite: z
      .boolean()
      .default(true)
      .describe("Run the Judge on the write path when one is available"),
    thresholds: z
      .object({
        dedupe: ThresholdSchema.default({ act: 0.85, review: 0.6 }),
        contradict: ThresholdSchema.default({ act: 0.85, review: 0.6 }),
        promote: ThresholdSchema.default({ act: 0.7, review: 0.5 }),
        reflect: z
          .object({
            minEpisodes: z.number().int().min(2).default(3),
            flagAt: z.number().min(0).max(1).default(0.7),
          })
          .prefault({}),
      })
      .prefault({}),
    maxPairsPerRun: z.number().int().positive().default(2000),
    candidatesPerMemory: z.number().int().positive().max(20).default(5),
    rerank: z
      .boolean()
      .default(true)
      .describe("Judge-backed rerank of the top candidates on recall"),
    rerankTopK: z.number().int().positive().max(50).default(15),
    typesafe: z
      .object({ model: z.string().optional(), apiKeyEnv: z.string().default("TYPESAFE_API_KEY") })
      .prefault({}),
    openai: z
      .object({
        baseUrl: z.string().default("http://localhost:11434/v1"),
        model: z.string().default("qwen3:latest"),
        apiKeyEnv: z.string().default("OPENAI_API_KEY"),
      })
      .prefault({}),
    claude: z.object({ model: z.string().optional() }).prefault({}),
  })
  .strict();
export type DreamConfig = z.infer<typeof DreamConfigSchema>;

export const PurgeInputSchema = z
  .object({
    memoryId: z.string().min(1),
    reason: z.string().min(1).max(1000).describe("Recorded in the purge marker"),
    forgetHistory: z.boolean().default(false).describe("Also drop the shard's ref history"),
  })
  .strict();
export type PurgeInput = z.infer<typeof PurgeInputSchema>;
