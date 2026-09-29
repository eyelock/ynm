import { z } from "zod";
import { ULID_PATTERN } from "./ulid.js";

export const MODEL_SCHEMA_VERSION = 1 as const;

/** The six memory types (ADR-001). */
export const MEMORY_TYPES = [
  "working",
  "episodic",
  "semantic",
  "procedural",
  "reflective",
  "reference",
] as const;
export const MemoryTypeSchema = z.enum(MEMORY_TYPES).describe("Memory type (ADR-001)");
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

/** The privacy boundary is binary (ADR-001, ADR-007). */
export const LEVELS = ["personal", "distributed"] as const;
export const LevelSchema = z
  .enum(LEVELS)
  .describe("personal never leaves the user's store by default");
export type Level = z.infer<typeof LevelSchema>;

/** Record operations; a memory is the fold of its records (ADR-002). */
export const OPS = [
  "create",
  "supersede",
  "annotate",
  "tombstone",
  "purge-marker",
  "snapshot",
] as const;
export const OpSchema = z.enum(OPS);
export type Op = z.infer<typeof OpSchema>;

/** Typed relations between memories (ADR-002). */
export const RELATIONS = [
  "supersedes",
  "derives-from",
  "contradicts",
  "supports",
  "about",
  "in-session",
] as const;
export const RelationSchema = z.enum(RELATIONS);
export type Relation = z.infer<typeof RelationSchema>;

/** Namespaces are unbounded `/`-separated paths; segments are [a-z0-9._-] (ADR-001). */
export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
export const NamespaceSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    NAMESPACE_PATTERN,
    "namespace segments start with [a-z0-9] and contain [a-z0-9._-], separated by /"
  )
  .refine(
    (ns) => ns.split("/").every((seg) => !seg.endsWith(".lock") && !seg.includes("..")),
    "namespace segments cannot contain .. or end with .lock"
  )
  .describe(
    "Hierarchical namespace, e.g. common, user/david, org/eyelock/project/ynm, session/<id>"
  );

/** Well-known namespaces (ADR-001). */
export const COMMON_NAMESPACE = "common";
export const userNamespace = (id: string): string => `user/${id}`;
/** Session ids may be anything a client sends; the namespace segment must be a valid ref component. */
export const normalizeSessionId = (id: string): string =>
  id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 100) || "session";
export const sessionNamespace = (id: string): string => `session/${normalizeSessionId(id)}`;

export const UlidSchema = z.string().regex(ULID_PATTERN, "must be a ULID");
/** A bare `YYYY-MM-DD` means midnight UTC. */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const IsoDateTimeSchema = z
  .preprocess(
    (v) => (typeof v === "string" && BARE_DATE.test(v) ? `${v}T00:00:00.000Z` : v),
    z.iso.datetime({ offset: true, error: "expected an ISO 8601 date-time" })
  )
  .describe("ISO 8601 date-time");
export const IsoDurationSchema = z
  .string()
  .regex(
    /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/,
    "must be an ISO 8601 duration"
  )
  .describe("ISO 8601 duration, e.g. PT2H or P7D");
export const UnitSchema = z.number().min(0).max(1);

export const LinkSchema = z
  .object({ rel: RelationSchema, to: UlidSchema.describe("memoryId of the target") })
  .describe("Typed link to another memory");
export type Link = z.infer<typeof LinkSchema>;

export const ProvenanceSchema = z
  .object({
    actor: z.string().min(1).describe("Who wrote it, e.g. agent:claude-code or user:david"),
    session: z.string().optional().describe("Session id"),
    source: z.string().optional().describe("Source reference: URL, file, ticket, tool call"),
    tool: z.string().optional().describe("Tool or command that produced the record"),
  })
  .describe("Where the record came from (ADR-002)");
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const JsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * One line of the log. Immutable. The canonical shape every provider stores and every consumer
 * reads (ADR-002).
 */
export const MemoryRecordSchema = z
  .object({
    v: z.literal(MODEL_SCHEMA_VERSION).describe("Record schema version"),
    id: UlidSchema.describe("Record id; sortable by time"),
    memoryId: UlidSchema.describe("Memory this record belongs to; equals id for the first record"),
    op: OpSchema,
    type: MemoryTypeSchema,
    level: LevelSchema,
    namespace: NamespaceSchema,
    subject: z.string().max(200).optional().describe("Entity or topic key, e.g. entity:git-notes"),
    tags: z.array(z.string().min(1).max(64)).default([]),
    content: z.string().max(65_536).optional().describe("Markdown; the memory itself"),
    summary: z.string().max(280).optional().describe("One line for index.md and pinned context"),
    data: JsonObjectSchema.optional().describe("Optional structured payload for typed memories"),
    dataSchema: z.string().max(100).optional().describe("Name of the expected shape of data"),
    importance: UnitSchema.optional().describe("0..1; writer-supplied default 0.5"),
    confidence: UnitSchema.optional().describe("0..1"),
    pinned: z.boolean().optional().describe("Always included in the context block"),
    needsReview: z.boolean().optional().describe("Flagged by a low-confidence model decision"),
    recordedAt: IsoDateTimeSchema.describe("Transaction time"),
    validFrom: IsoDateTimeSchema.optional().describe("Event time the memory became true"),
    validTo: IsoDateTimeSchema.nullable().optional().describe("Event time it stopped being true"),
    ttl: IsoDurationSchema.optional().describe("Working memory only"),
    provenance: ProvenanceSchema,
    links: z.array(LinkSchema).default([]),
    reason: z
      .string()
      .max(1000)
      .optional()
      .describe("Why, for tombstone, purge-marker and annotate"),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.op === "create" || r.op === "supersede") && !r.content) {
      ctx.addIssue({ code: "custom", path: ["content"], message: `${r.op} requires content` });
    }
    if (r.op === "create" && r.memoryId !== r.id) {
      ctx.addIssue({
        code: "custom",
        path: ["memoryId"],
        message: "create must have memoryId === id",
      });
    }
    if (r.op === "supersede" && !r.links.some((l) => l.rel === "supersedes")) {
      ctx.addIssue({
        code: "custom",
        path: ["links"],
        message: "supersede requires a supersedes link",
      });
    }
    if (r.op === "snapshot" && !r.data) {
      ctx.addIssue({ code: "custom", path: ["data"], message: "snapshot requires data" });
    }
    if (r.type === "working" && !r.namespace.startsWith("session/")) {
      ctx.addIssue({
        code: "custom",
        path: ["namespace"],
        message: "working memory must live in session/<id>",
      });
    }
  });
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
export type MemoryRecordInput = z.input<typeof MemoryRecordSchema>;

/** Working memory always expires; this is the TTL when none is given (ADR-001). */
export const DEFAULT_WORKING_TTL = "PT8H";

/** Fields a caller supplies when creating a memory; everything else is stamped by the service. */
const RememberFieldsSchema = z
  .object({
    type: MemoryTypeSchema,
    level: LevelSchema.default("personal"),
    namespace: NamespaceSchema.default(COMMON_NAMESPACE),
    content: z.string().min(1).max(65_536).describe("Markdown; the memory itself"),
    summary: z
      .string()
      .max(280)
      .optional()
      .describe("One line summary; derived from content if omitted"),
    subject: z.string().max(200).optional().describe("Entity or topic key"),
    tags: z.array(z.string().min(1).max(64)).default([]).describe("Free-form tags"),
    data: JsonObjectSchema.optional().describe("Structured payload (JSON object)"),
    dataSchema: z.string().max(100).optional().describe("Name of the shape of data"),
    importance: UnitSchema.default(0.5).describe("0..1"),
    confidence: UnitSchema.default(1).describe("0..1"),
    validFrom: IsoDateTimeSchema.optional().describe("When it became true"),
    validTo: IsoDateTimeSchema.optional().describe("When it stopped being true"),
    ttl: IsoDurationSchema.optional().describe(
      `Working memory TTL; defaults to ${DEFAULT_WORKING_TTL} for type working`
    ),
    session: z.string().optional().describe("Session id for provenance"),
    source: z.string().optional().describe("Source reference for provenance"),
    links: z.array(LinkSchema).default([]).describe("Typed links to other memories"),
  })
  .strict();
export const RememberInputSchema = RememberFieldsSchema.overwrite((r) =>
  r.type === "working" && r.ttl === undefined ? { ...r, ttl: DEFAULT_WORKING_TTL } : r
);
export type RememberInput = z.infer<typeof RememberInputSchema>;

export const SupersedeInputSchema = RememberFieldsSchema.pick({
  content: true,
  summary: true,
  subject: true,
  tags: true,
  data: true,
  dataSchema: true,
  importance: true,
  confidence: true,
  validFrom: true,
  validTo: true,
  session: true,
  source: true,
  links: true,
})
  .extend({ memoryId: UlidSchema.describe("Memory to supersede") })
  .strict();
export type SupersedeInput = z.infer<typeof SupersedeInputSchema>;

export const AnnotateInputSchema = z
  .object({
    memoryId: UlidSchema.describe("Memory to annotate"),
    tags: z.array(z.string().min(1).max(64)).optional().describe("Tags to add"),
    links: z.array(LinkSchema).optional().describe("Links to add"),
    importance: UnitSchema.optional().describe("New importance"),
    confidence: UnitSchema.optional().describe("New confidence"),
    pinned: z.boolean().optional().describe("Pin or unpin"),
    needsReview: z.boolean().optional().describe("Flag or clear review"),
    reason: z.string().max(1000).optional().describe("Why"),
    session: z.string().optional(),
    data: JsonObjectSchema.optional().describe("Judgment or other structured annotation data"),
  })
  .strict();
export type AnnotateInput = z.infer<typeof AnnotateInputSchema>;

export const ForgetInputSchema = z
  .object({
    memoryId: UlidSchema.describe("Memory to tombstone"),
    reason: z.string().max(1000).optional().describe("Why"),
    session: z.string().optional(),
  })
  .strict();
export type ForgetInput = z.infer<typeof ForgetInputSchema>;

/** Filter used by list, export and the store's shard scan. */
export const RecordFilterSchema = z
  .object({
    level: LevelSchema.optional(),
    type: MemoryTypeSchema.optional(),
    namespace: z.string().optional().describe("Namespace prefix"),
    since: IsoDateTimeSchema.optional(),
    until: IsoDateTimeSchema.optional(),
    includeTombstoned: z.boolean().default(false),
    needsReview: z.boolean().optional().describe("Only memories flagged for review"),
    limit: z.number().int().positive().max(10_000).optional(),
  })
  .strict();
export type RecordFilter = z.infer<typeof RecordFilterSchema>;

/** Derives a one-line summary from content when the caller gave none. */
export function summarize(content: string): string {
  const firstLine = content.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const cleaned = firstLine.replace(/^#+\s*/, "").trim();
  return cleaned.length > 280 ? `${cleaned.slice(0, 277)}...` : cleaned;
}
