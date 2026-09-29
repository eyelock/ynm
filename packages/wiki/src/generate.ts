import type { MemoryRecord } from "@ynm/model";
import type { Memory } from "@ynm/store";

export interface WikiPage {
  /** Relative path inside the wiki, e.g. index.md, entities/git-notes.md. */
  path: string;
  content: string;
}

export interface WikiInput {
  memories: Iterable<Memory>;
  /** Raw records for log.md; optional (a mount may be large). */
  records?: Iterable<MemoryRecord>;
  title?: string;
  generatedAt?: string;
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/^(entity|topic):/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}

function frontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(
      ([k, v]) =>
        `${k}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : typeof v === "string" ? JSON.stringify(v) : String(v)}`
    );
  return `---\n${lines.join("\n")}\n---\n`;
}

function memoryLine(m: Memory): string {
  const s = m.current.summary ?? m.current.content?.split("\n")[0] ?? "";
  return `- [${s}](memories/${m.memoryId}.md)${m.pinned ? " (pinned)" : ""}${m.subject ? ` · ${m.subject}` : ""}`;
}

/**
 * Karpathy-style projection (ADR-010): index.md catalog, log.md chronology, one page per memory,
 * entity pages per subject, topic pages per tag. Pure: fold in, pages out. OKF-style
 * frontmatter with `type` as the required field.
 */
export function generateWiki(input: WikiInput): WikiPage[] {
  const at = input.generatedAt ?? new Date().toISOString();
  const memories = [...input.memories]
    .filter((m) => !m.tombstoned)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const pages: WikiPage[] = [];
  const title = input.title ?? "Memory";

  const byGroup = new Map<string, Memory[]>();
  for (const m of memories) {
    const key = `${m.level} · ${m.namespace} · ${m.type}`;
    const list = byGroup.get(key) ?? [];
    list.push(m);
    byGroup.set(key, list);
  }
  const indexBody = [...byGroup.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([group, list]) => `## ${group}\n\n${list.map(memoryLine).join("\n")}\n`)
    .join("\n");
  pages.push({
    path: "index.md",
    content: `${frontmatter({ type: "index", generated: true, generatedAt: at, memories: memories.length })}# ${title}\n\nOne line per memory, grouped by level, namespace and type. Entities and topics have their own pages.\n\n${indexBody}`,
  });

  if (input.records) {
    const records = [...input.records].sort((a, b) =>
      a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.id < b.id ? -1 : 1
    );
    const lines = records.map(
      (r) =>
        `## [${r.recordedAt.slice(0, 10)}] ${r.op} | ${r.summary ?? r.content?.split("\n")[0] ?? r.reason ?? r.memoryId}`
    );
    pages.push({
      path: "log.md",
      content: `${frontmatter({ type: "log", generated: true, generatedAt: at })}# Log\n\nAppend-only chronology of records. \`grep "^## \\[" log.md | tail\` shows the latest.\n\n${lines.join("\n")}\n`,
    });
  }

  for (const m of memories) {
    const c = m.current;
    pages.push({
      path: `memories/${m.memoryId}.md`,
      content: `${frontmatter({ type: "memory", memoryId: m.memoryId, memoryType: m.type, level: m.level, namespace: m.namespace, subject: m.subject, tags: m.tags, importance: m.importance, confidence: m.confidence, pinned: m.pinned || undefined, needsReview: m.needsReview || undefined, createdAt: m.createdAt, updatedAt: m.updatedAt, versions: m.versions, dataSchema: c.dataSchema })}# ${c.summary ?? m.memoryId}\n\n${(c.content ?? "").trim()}\n${c.data ? `\n\`\`\`json\n${JSON.stringify(c.data, null, 2)}\n\`\`\`\n` : ""}${m.links.length ? `\n## Links\n\n${m.links.map((l) => `- ${l.rel} → [${l.to}](${l.to}.md)`).join("\n")}\n` : ""}`,
    });
  }

  const bySubject = new Map<string, Memory[]>();
  for (const m of memories) {
    if (!m.subject) continue;
    const list = bySubject.get(m.subject) ?? [];
    list.push(m);
    bySubject.set(m.subject, list);
  }
  for (const [subject, list] of bySubject) {
    const reflective = list.filter((m) => m.type === "reflective");
    const rest = list.filter((m) => m.type !== "reflective");
    pages.push({
      path: `entities/${slug(subject)}.md`,
      content: `${frontmatter({ type: "entity", subject, generated: true, generatedAt: at, memories: list.length })}# ${subject}\n\n${reflective.length ? `## Reflection\n\n${reflective.map((m) => `${(m.current.content ?? "").trim()}\n`).join("\n")}\n` : ""}## Memories\n\n${rest.map(memoryLine).join("\n")}\n`,
    });
  }

  const byTag = new Map<string, Memory[]>();
  for (const m of memories)
    for (const t of m.tags) {
      const list = byTag.get(t) ?? [];
      list.push(m);
      byTag.set(t, list);
    }
  for (const [tag, list] of byTag) {
    pages.push({
      path: `topics/${slug(tag)}.md`,
      content: `${frontmatter({ type: "topic", tag, generated: true, generatedAt: at, memories: list.length })}# ${tag}\n\n${list.map(memoryLine).join("\n")}\n`,
    });
  }
  return pages.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Parses an edited memory page back into (memoryId, content, page title as summary) for `wiki ingest`. */
export function parseMemoryPage(
  text: string
): { memoryId: string; content: string; summary?: string } | null {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) return null;
  const idMatch = /^memoryId:\s*"?([0-9A-Z]{26})"?\s*$/m.exec(m[1] as string);
  if (!idMatch) return null;
  const title = /^# ([^\n]*)\n/.exec(m[2] as string)?.[1]?.trim();
  const body = (m[2] as string).replace(/^# [^\n]*\n\n?/, "");
  const content = body.split(/\n```json\n|\n## Links\n/)[0]?.trim() ?? "";
  return { memoryId: idMatch[1] as string, content, ...(title ? { summary: title } : {}) };
}
