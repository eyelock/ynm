import { z } from "zod";
import { IsoDurationSchema } from "./record.js";

export const SessionStartInputSchema = z
  .object({
    sessionId: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Client session id; generated if omitted"),
    namespace: z.string().optional().describe("Namespace prefix for the context block"),
    budgetTokens: z
      .number()
      .int()
      .positive()
      .max(50_000)
      .default(1500)
      .describe("Context block budget"),
    ttl: IsoDurationSchema.default("PT8H").describe(
      "Default TTL for working memory in this session"
    ),
  })
  .strict();
export type SessionStartInput = z.infer<typeof SessionStartInputSchema>;

export const SessionEndInputSchema = z
  .object({
    sessionId: z.string().min(1).max(100).describe("Session to end"),
    expire: z.boolean().default(true).describe("Tombstone expired working memory now"),
  })
  .strict();
export type SessionEndInput = z.infer<typeof SessionEndInputSchema>;

/** Consolidation passes (ADR-006); model-backed passes fall back to non-model behaviour. */
export const CONSOLIDATE_PASSES = [
  "expire",
  "promote",
  "dedupe",
  "contradict",
  "reflect",
  "normalise",
] as const;
export const ConsolidateInputSchema = z
  .object({
    passes: z
      .array(z.enum(CONSOLIDATE_PASSES))
      .default([...CONSOLIDATE_PASSES])
      .describe("Passes to run"),
    namespace: z.string().optional().describe("Restrict to a namespace prefix"),
    dryRun: z.boolean().default(false).describe("Report what would change"),
    maxPairs: z.number().int().positive().optional().describe("Cap on judged pairs this run"),
  })
  .strict();
export type ConsolidateInput = z.infer<typeof ConsolidateInputSchema>;

export const SyncInputSchema = z
  .object({
    remote: z.string().optional().describe("Remote name"),
    push: z.boolean().default(true),
    pull: z.boolean().default(true),
    dryRun: z.boolean().default(false),
    mount: z.string().optional().describe("Only this mount"),
  })
  .strict();
export type SyncInput = z.infer<typeof SyncInputSchema>;

export const PromoteInputSchema = z
  .object({
    memoryId: z.string().min(1),
    mount: z.string().optional().describe("Target distributed mount"),
  })
  .strict();
