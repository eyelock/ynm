import { z } from "zod";
import { IsoDateTimeSchema, LevelSchema, MemoryTypeSchema, UlidSchema } from "./record.js";

/** The single recall input for MCP and CLI (ADR-005). */
export const RecallQuerySchema = z
  .object({
    text: z
      .string()
      .max(2000)
      .optional()
      .describe("Free text; omit to filter and rank by recency and importance only"),
    type: z.array(MemoryTypeSchema).optional().describe("Restrict to these memory types"),
    level: z.array(LevelSchema).optional().describe("Restrict to these levels"),
    namespace: z.string().optional().describe("Namespace prefix"),
    subject: z.string().optional().describe("Exact subject key"),
    tags: z.array(z.string()).optional().describe("All of these tags must be present"),
    dataKey: z.string().optional().describe("Only memories whose data has this key"),
    since: IsoDateTimeSchema.optional().describe("Updated at or after"),
    until: IsoDateTimeSchema.optional().describe("Updated at or before"),
    pinnedOnly: z.boolean().default(false).describe("Only pinned memories"),
    includeTombstoned: z
      .boolean()
      .default(false)
      .describe("Include forgotten (tombstoned) memories"),
    limit: z.number().int().positive().max(200).default(10).describe("Maximum number of hits"),
    explain: z.boolean().default(false).describe("Return score components"),
    rerank: z
      .boolean()
      .optional()
      .describe("Judge-backed rerank of the top candidates (default from config)"),
    mount: z.string().optional().describe("Only this mount"),
  })
  .strict();
export type RecallQuery = z.infer<typeof RecallQuerySchema>;

/** Pinned plus top memories packed to a token budget, rendered as markdown (ADR-005). */
export const ContextQuerySchema = z
  .object({
    namespace: z.string().optional().describe("Namespace prefix"),
    level: z.array(LevelSchema).optional().describe("Restrict to these levels"),
    type: z.array(MemoryTypeSchema).optional().describe("Restrict to these memory types"),
    text: z.string().max(2000).optional().describe("Optional focus text for the ranked part"),
    budgetTokens: z
      .number()
      .int()
      .positive()
      .max(50_000)
      .default(1500)
      .describe("Approximate token budget"),
    mount: z.string().optional().describe("Only this mount"),
  })
  .strict();
export type ContextQuery = z.infer<typeof ContextQuerySchema>;

export const PinInputSchema = z
  .object({ memoryId: UlidSchema, pinned: z.boolean().default(true).describe("false to unpin") })
  .strict();
export type PinInput = z.infer<typeof PinInputSchema>;

/** Score components a ranker exposes when explain is requested. */
export interface ScoreExplain {
  relevance: number;
  recency: number;
  importance: number;
  pinned: number;
  total: number;
  weights: { relevance: number; recency: number; importance: number; pinned: number };
}
