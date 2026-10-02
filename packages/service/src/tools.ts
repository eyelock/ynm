import {
  AnnotateInputSchema,
  ConsolidateInputSchema,
  ContextQuerySchema,
  ForgetInputSchema,
  PromoteInputSchema,
  RecallQuerySchema,
  RememberInputSchema,
  SessionEndInputSchema,
  SessionStartInputSchema,
  SupersedeInputSchema,
  SyncInputSchema,
} from "@ynm/model";
import type { z } from "zod";
import { z as zod } from "zod";
import { REMEMBER_INTENT_EXAMPLES } from "./hooks/intent.js";
import { Lifecycle } from "./lifecycle.js";
import type { Ynm } from "./ynm.js";

export interface ToolResult {
  /** JSON-serialisable payload; the MCP layer returns it as structured content and text. */
  data: unknown;
  /** Short guidance appended to tool results for the agent (ADR-008: guidance, not gating). */
  guidance?: string;
}

export interface ToolSpec<S extends z.ZodObject = z.ZodObject> {
  name: string;
  /** The CLI command that mirrors this tool (parity test, ADR-008). */
  command: string;
  description: string;
  input: S;
  readOnly: boolean;
  run(ynm: Ynm, input: z.infer<S>): Promise<ToolResult>;
}

const MemorySessionInputSchema = zod
  .object({
    action: zod.enum(["start", "end"]).describe("start or end a session"),
    sessionId: zod.string().optional().describe("Session id (required for end)"),
    namespace: zod.string().optional().describe("Namespace prefix for the context block"),
    budgetTokens: zod
      .number()
      .int()
      .positive()
      .max(50_000)
      .default(1500)
      .describe("Context block budget"),
    ttl: zod.string().default("PT8H").describe("Default working-memory TTL"),
    expire: zod.boolean().default(true).describe("On end: tombstone expired working memory"),
  })
  .strict();

const MemoryStatusInputSchema = zod.object({}).strict();

function spec<S extends z.ZodObject>(s: ToolSpec<S>): ToolSpec<S> {
  return s;
}

/** The ten tools of ADR-008. MCP and CLI are thin adapters over these. */
export const TOOL_SPECS = [
  spec({
    name: "memory_remember",
    command: "remember",
    description: `Save to the user's persistent memory. Call it whenever the user asks you to remember something or states a preference or standing instruction (${REMEMBER_INTENT_EXAMPLES}), instead of any built-in memory, memory directory or notes file. One fact per memory; choose type (semantic facts, episodic events, procedural how-to, reference pointers, working scratch). Leave level out for the store's default (personal when it has a personal mount, else distributed); distributed only for team-safe project facts. Never store secrets.`,
    input: RememberInputSchema,
    readOnly: false,
    async run(ynm, input) {
      const r = await ynm.remember(input);
      let guidance: string | undefined;
      if (ynm.index) {
        const similar = (await ynm.recall({ text: input.content.slice(0, 200), limit: 4 })).filter(
          (h) => h.memoryId !== r.memoryId
        );
        if (similar.length) {
          guidance = `${similar.length} similar memor${similar.length === 1 ? "y exists" : "ies exist"}: ${similar
            .map((h) => `${h.memoryId} (${h.summary})`)
            .join(
              "; "
            )}. If one of them is the same fact, prefer memory_supersede over a duplicate.`;
        }
      }
      return { data: r, guidance };
    },
  }),
  spec({
    name: "memory_recall",
    command: "recall",
    description:
      "Search the user's persistent memory, ranked by relevance, recency and importance. Call it with the key terms before answering about the user's preferences, the project or past decisions.",
    input: RecallQuerySchema,
    readOnly: true,
    async run(ynm, input) {
      const hits = await ynm.recall(input);
      return {
        data: hits,
        guidance: hits.length
          ? undefined
          : "No matches. Try broader terms, drop filters, or check memory_context for pinned memories.",
      };
    },
  }),
  spec({
    name: "memory_context",
    command: "context",
    description:
      "The user's memory for this session: pinned memories first, then the most relevant, packed to a token budget. Read it at the start of a task and before answering about the user's preferences, the project or past decisions.",
    input: ContextQuerySchema,
    readOnly: true,
    async run(ynm, input) {
      return { data: await ynm.context(input) };
    },
  }),
  spec({
    name: "memory_supersede",
    command: "supersede",
    description:
      "Record a new version of an existing memory. Use when a remembered fact is wrong or incomplete instead of creating a duplicate.",
    input: SupersedeInputSchema,
    readOnly: false,
    async run(ynm, input) {
      return { data: await ynm.supersede(input) };
    },
  }),
  spec({
    name: "memory_annotate",
    command: "annotate",
    description:
      "Add tags, links, pin, importance or review flags to a memory without changing its content.",
    input: AnnotateInputSchema,
    readOnly: false,
    async run(ynm, input) {
      return { data: await ynm.annotate(input) };
    },
  }),
  spec({
    name: "memory_forget",
    command: "forget",
    description:
      "Tombstone a memory so it stops being recalled. History is kept; a later supersede can revive it.",
    input: ForgetInputSchema,
    readOnly: false,
    async run(ynm, input) {
      return { data: await ynm.forget(input) };
    },
  }),
  spec({
    name: "memory_session",
    command: "session",
    description:
      "Start a session (returns a session id, its working-memory namespace and the context block) or end one (expires working memory).",
    input: MemorySessionInputSchema,
    readOnly: false,
    async run(ynm, input) {
      const life = new Lifecycle(ynm);
      if (input.action === "start") {
        const s = await life.start(
          SessionStartInputSchema.parse({
            sessionId: input.sessionId,
            namespace: input.namespace,
            budgetTokens: input.budgetTokens,
            ttl: input.ttl,
          })
        );
        return {
          data: s,
          guidance: `Write working memory to namespace ${s.namespace} with type working and ttl ${s.ttl}. Call memory_session end when done.`,
        };
      }
      if (!input.sessionId) throw new Error("sessionId is required to end a session");
      return {
        data: await life.end(
          SessionEndInputSchema.parse({ sessionId: input.sessionId, expire: input.expire })
        ),
      };
    },
  }),
  spec({
    name: "memory_consolidate",
    command: "dream",
    description:
      "Run consolidation passes: expire, promote, dedupe, contradict, reflect, normalise. Judged by the configured Judge; uncalibrated judges flag for review instead of acting.",
    input: ConsolidateInputSchema,
    readOnly: false,
    async run(ynm, input) {
      return { data: await new Lifecycle(ynm).consolidate(input) };
    },
  }),
  spec({
    name: "memory_sync",
    command: "sync",
    description:
      "Fetch, merge and push distributed memory with the configured remote. Personal memory is never synced by this tool.",
    input: SyncInputSchema,
    readOnly: false,
    async run(ynm, input) {
      return { data: await ynm.sync(input) };
    },
  }),
  spec({
    name: "memory_status",
    command: "status",
    description: "Mounts, shard counts and index freshness.",
    input: MemoryStatusInputSchema,
    readOnly: true,
    async run(ynm) {
      return { data: { ...(await ynm.status()), index: await ynm.indexStatus() } };
    },
  }),
] as const satisfies readonly ToolSpec[];

export const TOOL_NAMES = TOOL_SPECS.map((t) => t.name);

export function toolSpec(name: string): ToolSpec | undefined {
  return (TOOL_SPECS as readonly ToolSpec[]).find((t) => t.name === name);
}

export { PromoteInputSchema };
