import type { MemoryRecord, MemoryType } from "@ynm/model";
import { ulid } from "@ynm/model";

/** mulberry32: small, seedable, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Realistic memory templates. Each has an entity slot, a value slot and several paraphrases of
 * the same claim. Truth labels are derived from claim identity after generation, so chance
 * collisions count too: same template, entity and value is a duplicate pair; same template and
 * entity with different values contradicts only when the template is exclusive (ADR-014).
 */
const SERVICES = [
  "payments",
  "search",
  "billing",
  "notifications",
  "auth",
  "catalog",
  "checkout",
  "reporting",
  "ingest",
  "scheduler",
  "gateway",
  "inventory",
  "pricing",
  "ledger",
  "identity",
  "media",
  "messaging",
  "analytics",
  "exports",
  "webhooks",
  "fraud",
  "orders",
  "shipping",
  "reviews",
  "support",
  "onboarding",
  "admin",
  "mobile-api",
  "feature-flags",
  "audit",
];
const PEOPLE = [
  "David",
  "Priya",
  "Marcus",
  "Yuki",
  "Amara",
  "Tomás",
  "Ingrid",
  "Kwame",
  "Leila",
  "Bjorn",
  "Sofia",
  "Ravi",
  "Hana",
  "Diego",
  "Nadia",
  "Oluwaseun",
  "Mei",
  "Lars",
  "Zara",
  "Ethan",
];

interface Template {
  type: MemoryType;
  /** Entity patterns; {s} is a service, {p} a person. */
  entities: string[];
  values: string[];
  /** Use {e} and {v}. */
  paraphrases: string[];
  tags: string[];
  /** True when an entity can hold only one value at a time. */
  exclusive: boolean;
}

const TEMPLATES: Template[] = [
  {
    type: "semantic",
    entities: [
      "the {s} staging environment",
      "the {s} production environment",
      "the {s} demo environment",
    ],
    values: [
      "blue-heron",
      "grey-owl",
      "red-kite",
      "black-swan",
      "silver-fox",
      "green-turtle",
      "amber-lynx",
      "white-hare",
    ],
    paraphrases: [
      "The {e} deploy target is the {v} cluster.",
      "We deploy {e} to the cluster called {v}.",
      "{e} runs on the {v} cluster.",
      "Deploys for {e} go to {v}.",
    ],
    tags: ["deploy", "infra"],
    exclusive: true,
  },
  {
    type: "procedural",
    entities: ["a {s} release", "a {s} hotfix", "a {s} schema migration", "a {s} dependency bump"],
    values: [
      "run the full gate",
      "get two reviews",
      "post in #releases",
      "tag after CI is green",
      "update the changelog",
      "run the smoke tests",
      "notify on-call",
      "bump the version",
    ],
    paraphrases: [
      "Before {e} ships, {v}.",
      "For {e}, the rule is: {v}.",
      "Shipping {e} requires that we {v}.",
      "Never ship {e} until you {v}.",
    ],
    tags: ["process", "release"],
    exclusive: false,
  },
  {
    type: "semantic",
    entities: ["the {s} team", "the {s} guild", "the {s} on-call rotation"],
    values: [
      "Tuesday 10:00",
      "Thursday 14:00",
      "Monday 09:30",
      "Wednesday 16:00",
      "Friday 11:00",
      "Tuesday 15:30",
      "Monday 13:00",
      "Thursday 09:00",
    ],
    paraphrases: [
      "{e} meets on {v}.",
      "The weekly sync for {e} is {v}.",
      "{e}'s standing meeting is at {v}.",
      "Meeting time for {e}: {v}.",
    ],
    tags: ["meetings"],
    exclusive: true,
  },
  {
    type: "semantic",
    entities: ["the {s} CLI", "the {s} service", "the {s} worker", "the {s} SDK"],
    values: [
      "Node 22 or later",
      "SQLite with FTS5",
      "git 2.40 or later",
      "pnpm 9",
      "Postgres 16",
      "Redis 7",
      "Go 1.23",
      "Python 3.12",
    ],
    paraphrases: [
      "{e} requires {v}.",
      "{e} depends on {v}.",
      "You need {v} to run {e}.",
      "{e} will not work without {v}.",
    ],
    tags: ["tooling"],
    exclusive: false,
  },
  {
    type: "episodic",
    entities: [
      "the {s} 1.2 release",
      "the {s} March outage",
      "the {s} migration",
      "the {s} rewrite",
    ],
    values: [
      "a skipped gate",
      "an expired certificate",
      "a quadratic delete",
      "a same-second root tie",
    ],
    paraphrases: [
      "{e} slipped because of {v}.",
      "The cause of the trouble in {e} was {v}.",
      "{e}: root cause was {v}.",
      "We lost time on {e} due to {v}.",
    ],
    tags: ["incident"],
    exclusive: true,
  },
  {
    type: "reference",
    entities: [
      "the {s} on-call rota",
      "the {s} deploy runbook",
      "the {s} ADR index",
      "the {s} dashboard",
    ],
    values: [
      "the ops wiki",
      "docs/adr/README.md",
      "the Grafana folder",
      "the team Notion",
      "the shared drive",
      "the platform handbook",
      "the runbooks repo",
      "Confluence",
    ],
    paraphrases: [
      "{e} lives in {v}.",
      "Find {e} in {v}.",
      "{e} is kept at {v}.",
      "Location of {e}: {v}.",
    ],
    tags: ["reference"],
    exclusive: true,
  },
  {
    type: "semantic",
    entities: ["{p}", "{p} (as reviewer)", "{p} (as release manager)"],
    values: [
      "British spelling",
      "short commit messages",
      "squash merges",
      "draft PRs early",
      "small PRs",
      "conventional commits",
      "rebase over merge",
      "screenshots in PRs",
    ],
    paraphrases: [
      "{e} prefers {v}.",
      "{e} likes {v}.",
      "Preference noted for {e}: {v}.",
      "{e} asked for {v}.",
    ],
    tags: ["preference"],
    exclusive: false,
  },
  {
    type: "procedural",
    entities: ["the {s} store", "the {s} index", "the {s} cache", "the {s} queue"],
    values: [
      "ynm doctor",
      "ynm reindex",
      "ynm sync --dry-run",
      "ynm wiki build",
      "make check",
      "kubectl get pods",
      "pnpm gate",
      "the health endpoint",
    ],
    paraphrases: [
      "To check {e}, run {v}.",
      "{e} is inspected with {v}.",
      "Use {v} for {e}.",
      "The command for {e} is {v}.",
    ],
    tags: ["howto"],
    exclusive: false,
  },
];

const DETAILS = [
  "Agreed in the weekly sync.",
  "Documented after the retro.",
  "This came up during onboarding.",
  "Confirmed with the team lead.",
  "Noted while pairing.",
  "",
];

export interface GeneratedCorpus {
  records: MemoryRecord[];
  /** Pairs of memoryIds that assert the same claim (any paraphrase). */
  duplicates: Array<[string, string]>;
  /** Pairs of memoryIds that assert incompatible values for the same entity. */
  contradictions: Array<[string, string]>;
  /** Queries with the memoryIds that should rank for them. */
  queries: Array<{ text: string; relevant: string[] }>;
}

export interface GenerateOptions {
  seed?: number;
  count: number;
  level?: "personal" | "distributed";
  namespaces?: string[];
  types?: readonly MemoryType[];
  months?: string[];
  duplicateRate?: number;
  contradictionRate?: number;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/^the /, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sentenceOf(paraphrase: string, entity: string, value: string): string {
  const claim = paraphrase.replace("{e}", entity).replace("{v}", value);
  return claim.charAt(0).toUpperCase() + claim.slice(1);
}

/** Deterministic synthetic corpus of realistic memories with labelled duplicates and contradictions. */
export function generateCorpus(opts: GenerateOptions): GeneratedCorpus {
  const r = rng(opts.seed ?? 42);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const level = opts.level ?? "personal";
  const namespaces =
    opts.namespaces ??
    (level === "personal" ? ["user/test"] : ["common", "org/eyelock/project/ynm"]);
  const templates = opts.types ? TEMPLATES.filter((t) => opts.types?.includes(t.type)) : TEMPLATES;
  const months = opts.months ?? ["2026-06", "2026-07", "2026-08", "2026-09"];
  const dupRate = opts.duplicateRate ?? 0.05;
  const conRate = opts.contradictionRate ?? 0.02;
  const records: MemoryRecord[] = [];
  const bySubject = new Map<string, string[]>();
  const claims: Array<{ id: string; tpl: number; entity: string; value: string }> = [];
  let t = Date.parse("2026-06-01T00:00:00.000Z");

  const make = (
    tpl: Template,
    entity: string,
    value: string,
    paraphrase: string,
    detail: string
  ): MemoryRecord => {
    t += 1000 + Math.floor(r() * 5000);
    const month = pick(months);
    const day = 1 + Math.floor(r() * 27);
    const recordedAt = `${month}-${String(day).padStart(2, "0")}T${new Date(t).toISOString().slice(11)}`;
    const id = ulid(Date.parse(recordedAt) + Math.floor(r() * 1000), r);
    const sentence = sentenceOf(paraphrase, entity, value);
    const subject = `entity:${slug(entity)}`;
    const rec: MemoryRecord = {
      v: 1,
      id,
      memoryId: id,
      op: "create",
      type: tpl.type,
      level,
      namespace: pick(namespaces),
      subject,
      tags: [...tpl.tags],
      content: detail ? `${sentence} ${detail}` : sentence,
      summary: sentence.slice(0, 120),
      importance: Math.round(r() * 100) / 100,
      confidence: 1,
      recordedAt,
      provenance: { actor: "generator", session: `s${Math.floor(r() * 50)}` },
      links: [],
    };
    claims.push({ id, tpl: TEMPLATES.indexOf(tpl), entity, value });
    bySubject.set(subject, [...(bySubject.get(subject) ?? []), id]);
    return rec;
  };

  let i = 0;
  while (i < opts.count) {
    const tpl = pick(templates);
    const entity = pick(tpl.entities).replace("{s}", pick(SERVICES)).replace("{p}", pick(PEOPLE));
    const value = pick(tpl.values);
    const detail = pick(DETAILS);
    const paraphrase = pick(tpl.paraphrases);
    records.push(make(tpl, entity, value, paraphrase, detail));
    i += 1;
    const roll = r();
    if (roll < dupRate && i < opts.count) {
      const alternatives = tpl.paraphrases.filter((p) => p !== paraphrase);
      records.push(
        make(tpl, entity, value, alternatives.length ? pick(alternatives) : paraphrase, detail)
      );
      i += 1;
    } else if (roll < dupRate + conRate && i < opts.count && tpl.exclusive) {
      const otherValue = pick(tpl.values.filter((v) => v !== value));
      records.push(make(tpl, entity, otherValue, pick(tpl.paraphrases), pick(DETAILS)));
      i += 1;
    }
  }

  const duplicates: GeneratedCorpus["duplicates"] = [];
  const contradictions: GeneratedCorpus["contradictions"] = [];
  const byEntity = new Map<string, typeof claims>();
  for (const c of claims) {
    const k = `${c.tpl}|${c.entity}`;
    byEntity.set(k, [...(byEntity.get(k) ?? []), c]);
  }
  for (const group of byEntity.values()) {
    const tpl = TEMPLATES[group[0]?.tpl ?? 0] as Template;
    for (let x = 0; x < group.length; x++) {
      for (let y = x + 1; y < group.length; y++) {
        const a = group[x] as (typeof claims)[number];
        const b = group[y] as (typeof claims)[number];
        if (a.value === b.value) duplicates.push([a.id, b.id]);
        else if (tpl.exclusive) contradictions.push([a.id, b.id]);
      }
    }
  }

  const queries: GeneratedCorpus["queries"] = [];
  for (const [subject, ids] of bySubject) {
    if (queries.length >= 50) break;
    if (ids.length >= 2) queries.push({ text: subject.slice(7).replace(/-/g, " "), relevant: ids });
  }
  return { records, duplicates, contradictions, queries };
}
