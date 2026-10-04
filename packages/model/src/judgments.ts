import { z } from "zod";
import { IsoDurationSchema } from "./record.js";

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
  .object({
    act: z.number().min(0).max(1).describe("At or above: act (calibrated judge only)"),
    review: z.number().min(0).max(1).describe("At or above: flag for review"),
  })
  .refine((t) => t.review <= t.act, "review threshold must not exceed act threshold");

/** Confidence bands per pass (ADR-012): act automatically, act and flag, or queue for review. */
export const DreamConfigSchema = z
  .object({
    judge: z
      .enum(["auto", "heuristic", "typesafe", "writer-emulated"])
      .default("auto")
      .describe(
        "Judge seam. `auto`: TypeSafe when its key is set, else emulated over the Writer, else heuristic"
      ),
    writer: z
      .enum(["auto", "none", "claude-cli", "openai-compatible"])
      .default("auto")
      .describe(
        "Writer seam. `auto`: the `claude` CLI when installed, else an OpenAI-compatible endpoint when a key or `YNM_OPENAI_BASE_URL` is set, else none"
      ),
    judgeOnWrite: z
      .boolean()
      .default(true)
      .describe("Run the Judge on the write path when one is available"),
    thresholds: z
      .object({
        dedupe: ThresholdSchema.default({ act: 0.85, review: 0.6 }).describe(
          "Bands for merging near-duplicates"
        ),
        contradict: ThresholdSchema.default({ act: 0.85, review: 0.6 }).describe(
          "Bands for resolving contradictions"
        ),
        promote: ThresholdSchema.default({ act: 0.7, review: 0.5 }).describe(
          "Bands for promoting working memory"
        ),
        reflect: z
          .object({
            minEpisodes: z
              .number()
              .int()
              .min(2)
              .default(3)
              .describe("Episodes a subject needs before it is reflected on"),
            flagAt: z
              .number()
              .min(0)
              .max(1)
              .default(0.7)
              .describe("A verification question at or above this withholds the draft"),
          })
          .prefault({})
          .describe("Settings for the reflect pass"),
      })
      .prefault({})
      .describe("Confidence bands per pass"),
    occurrenceRetention: IsoDurationSchema.nullable()
      .default("P90D")
      .describe(
        "How long the expire pass keeps memories tagged `occurrence`, as an ISO 8601 duration since their last change; `null` keeps them forever. Occurrences the newest reflection on their subject links to are always kept"
      ),
    maxPairsPerRun: z
      .number()
      .int()
      .positive()
      .default(2000)
      .describe("Cap on judged pairs per dream run"),
    candidatesPerMemory: z
      .number()
      .int()
      .positive()
      .max(20)
      .default(5)
      .describe("Nearest neighbours considered per memory"),
    rerank: z
      .boolean()
      .default(true)
      .describe("Judge-backed rerank of the top candidates on recall"),
    rerankTopK: z
      .number()
      .int()
      .positive()
      .max(50)
      .default(15)
      .describe("Candidates the reranker judges"),
    typesafe: z
      .object({
        model: z.string().optional().describe("Model id; default: the service's latest Jev"),
        apiKeyEnv: z
          .string()
          .default("TYPESAFE_API_KEY")
          .describe("Environment variable holding the key"),
      })
      .prefault({})
      .describe("TypeSafe judge settings"),
    openai: z
      .object({
        baseUrl: z
          .string()
          .default("http://localhost:11434/v1")
          .describe("Endpoint base URL (`YNM_OPENAI_BASE_URL` overrides under `auto`)"),
        model: z
          .string()
          .default("qwen3:latest")
          .describe("Model name (`YNM_OPENAI_MODEL` overrides under `auto`)"),
        apiKeyEnv: z
          .string()
          .default("OPENAI_API_KEY")
          .describe("Environment variable holding the key"),
      })
      .prefault({})
      .describe("OpenAI-compatible writer settings"),
    claude: z
      .object({
        model: z
          .string()
          .optional()
          .describe("Model passed to `claude -p`; default: the CLI's own"),
      })
      .prefault({})
      .describe("Claude CLI writer settings"),
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
