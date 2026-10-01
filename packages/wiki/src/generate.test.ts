import type { MemoryRecord } from "@ynm/model";
import { fold, type Memory } from "@ynm/store";
import { generateWiki, parseMemoryPage, slug } from "./generate.js";

function rec(over: Partial<MemoryRecord>): MemoryRecord {
  const id = over.id ?? "01M0000000000000000000AAAA";
  return {
    v: 1,
    id,
    memoryId: over.memoryId ?? id,
    op: "create",
    type: "semantic",
    level: "personal",
    namespace: "user/test",
    tags: [],
    links: [],
    recordedAt: "2026-09-01T00:00:00.000Z",
    provenance: { actor: "t" },
    ...over,
  };
}

function memoriesOf(records: MemoryRecord[]): Memory[] {
  return [...fold(records).memories.values()];
}

function page(pages: { path: string; content: string }[], path: string): string {
  const p = pages.find((x) => x.path === path);
  if (!p) throw new Error(`no page ${path}`);
  return p.content;
}

describe("slug", () => {
  it("strips entity and topic prefixes and collapses punctuation", () => {
    expect(slug("topic:CI / Release")).toBe("ci-release");
    expect(slug("--Hello, World--")).toBe("hello-world");
  });
  it("falls back to untitled when nothing is left", () => {
    expect(slug("entity:!!!")).toBe("untitled");
    expect(slug("")).toBe("untitled");
  });
  it("caps the slug at 80 characters", () => {
    expect(slug("a".repeat(200))).toHaveLength(80);
  });
});

describe("generateWiki", () => {
  it("uses a default title and the current time, and skips log.md without records", () => {
    const before = new Date().toISOString();
    const pages = generateWiki({ memories: [] });
    expect(pages.map((p) => p.path)).toEqual(["index.md"]);
    const index = page(pages, "index.md");
    expect(index).toContain("# Memory\n");
    expect(index).toContain("memories: 0\n");
    const at = /generatedAt: "([^"]+)"/.exec(index)?.[1] ?? "";
    expect(at >= before).toBe(true);
  });

  it("titles a line from the first content line, or empty, when there is no summary", () => {
    const pages = generateWiki({
      memories: memoriesOf([
        rec({ id: "01M0000000000000000000AAAA", content: "first\nsecond" }),
        rec({ id: "01M0000000000000000000BBBB", content: undefined, data: { k: 1 } }),
      ]),
      generatedAt: "2026-09-29T00:00:00.000Z",
    });
    const index = page(pages, "index.md");
    expect(index).toContain("- [first](memories/01M0000000000000000000AAAA.md)\n");
    expect(index).toContain("- [](memories/01M0000000000000000000BBBB.md)\n");
    // With no summary, the memory page is titled by its id and has an empty body.
    const bare = page(pages, "memories/01M0000000000000000000BBBB.md");
    expect(bare).toContain("# 01M0000000000000000000BBBB\n\n\n");
    expect(bare).toContain('```json\n{\n  "k": 1\n}\n```');
  });

  it("writes needsReview, dataSchema and string, number and array frontmatter, omitting unset fields", () => {
    const pages = generateWiki({
      memories: memoriesOf([
        rec({
          summary: "s",
          content: "c",
          tags: ["x", 'quote"d'],
          needsReview: true,
          dataSchema: "ynm/build@1",
          importance: 0.25,
        }),
      ]),
      generatedAt: "2026-09-29T00:00:00.000Z",
    });
    const mem = page(pages, "memories/01M0000000000000000000AAAA.md");
    expect(mem).toContain('tags: ["x", "quote\\"d"]\n');
    expect(mem).toContain("importance: 0.25\n");
    expect(mem).toContain("needsReview: true\n");
    expect(mem).toContain('dataSchema: "ynm/build@1"\n');
    expect(mem).not.toMatch(/^pinned:/m);
    expect(mem).not.toMatch(/^subject:/m);
    expect(mem).not.toContain("## Links");
  });

  it("orders the log by time then id and labels each record by summary, content, reason or id", () => {
    const records = [
      rec({ id: "01M0000000000000000000BBBB", summary: "by summary" }),
      rec({ id: "01M0000000000000000000AAAA", content: "by content\nmore" }),
      rec({
        id: "01M0000000000000000000CCCC",
        memoryId: "01M0000000000000000000AAAA",
        op: "tombstone",
        reason: "by reason",
        recordedAt: "2026-09-03T00:00:00.000Z",
      }),
      rec({
        id: "01M0000000000000000000DDDD",
        memoryId: "01M0000000000000000000BBBB",
        op: "annotate",
        recordedAt: "2026-09-02T00:00:00.000Z",
      }),
    ];
    const log = page(
      generateWiki({ memories: memoriesOf(records), records, generatedAt: "x" }),
      "log.md"
    );
    const lines = log.split("\n").filter((l) => l.startsWith("## ["));
    expect(lines).toEqual([
      "## [2026-09-01] create | by content",
      "## [2026-09-01] create | by summary",
      "## [2026-09-02] annotate | 01M0000000000000000000BBBB",
      "## [2026-09-03] tombstone | by reason",
    ]);
  });

  it("builds an entity page without a reflection section when no reflective memory exists", () => {
    const pages = generateWiki({
      memories: memoriesOf([
        rec({ summary: "fact", subject: "entity:Build", tags: ["topic:CI"] }),
        rec({
          id: "01M0000000000000000000BBBB",
          type: "reflective",
          subject: "entity:Other",
          content: undefined,
        }),
      ]),
      generatedAt: "x",
    });
    const build = page(pages, "entities/build.md");
    expect(build).not.toContain("## Reflection");
    expect(build).toContain(
      "## Memories\n\n- [fact](memories/01M0000000000000000000AAAA.md) · entity:Build\n"
    );
    // A reflective memory without content still yields a (blank) reflection entry.
    expect(page(pages, "entities/other.md")).toContain("## Reflection\n\n\n\n## Memories\n\n\n");
    expect(page(pages, "topics/ci.md")).toContain('tag: "topic:CI"');
  });
});

describe("parseMemoryPage", () => {
  const id = "01M0000000000000000000AAAA";

  it("returns null when the frontmatter has no memory id", () => {
    expect(parseMemoryPage("---\ntype: memory\n---\n# T\n\nbody\n")).toBeNull();
    expect(parseMemoryPage('---\nmemoryId: "short"\n---\n# T\n')).toBeNull();
  });

  it("omits the summary when the page has no title", () => {
    expect(parseMemoryPage(`---\nmemoryId: ${id}\n---\njust body\n`)).toEqual({
      memoryId: id,
      content: "just body",
    });
  });

  it("stops the content at the links section or the data block", () => {
    const withLinks = `---\nmemoryId: "${id}"\n---\n# Title\n\nedited body\n\n## Links\n\n- x → [y](y.md)\n`;
    expect(parseMemoryPage(withLinks)).toEqual({
      memoryId: id,
      content: "edited body",
      summary: "Title",
    });
    const withData = `---\nmemoryId: "${id}"\n---\n# Title\n\nbody\n\n\`\`\`json\n{}\n\`\`\`\n`;
    expect(parseMemoryPage(withData)?.content).toBe("body");
  });

  it("round-trips a page generated with links", () => {
    const records = [
      rec({
        summary: "S",
        content: "linked body",
        links: [{ rel: "supports", to: "01M0000000000000000000BBBB" }],
      }),
    ];
    const mem = page(
      generateWiki({ memories: memoriesOf(records), generatedAt: "x" }),
      `memories/${id}.md`
    );
    expect(mem).toContain(
      "## Links\n\n- supports → [01M0000000000000000000BBBB](01M0000000000000000000BBBB.md)\n"
    );
    expect(parseMemoryPage(mem)).toEqual({ memoryId: id, content: "linked body", summary: "S" });
  });
});
