import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryRecord } from "@ynm/model";
import { ulid } from "@ynm/model";
import { fold } from "@ynm/store";
import { createRepo, fx } from "@ynm/store/testing/git";
import { generateWiki, parseMemoryPage, slug } from "./generate.js";
import { DirectoryTarget, OrphanBranchTarget } from "./targets.js";

function rec(over: Partial<MemoryRecord>): MemoryRecord {
  const id = over.id ?? ulid(Date.parse(over.recordedAt ?? "2026-09-01T00:00:00.000Z"));
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
    content: "body",
    summary: "summary",
    recordedAt: "2026-09-01T00:00:00.000Z",
    provenance: { actor: "t" },
    ...over,
  };
}

const AT = "2026-09-29T00:00:00.000Z";
const records: MemoryRecord[] = [
  rec({
    id: "01M0000000000000000000AAAA",
    subject: "entity:git-notes",
    tags: ["git", "storage"],
    summary: "Notes anchor to the root commit",
    content: "Notes anchor to the root commit.\n\nSecond paragraph.",
    recordedAt: "2026-09-01T00:00:00.000Z",
  }),
  rec({
    id: "01M0000000000000000000BBBB",
    type: "episodic",
    subject: "entity:git-notes",
    tags: ["git"],
    summary: "Rebase lost nothing",
    content: "A rebase kept every note.",
    recordedAt: "2026-09-02T00:00:00.000Z",
  }),
  rec({
    id: "01M0000000000000000000CCCC",
    type: "reflective",
    subject: "entity:git-notes",
    tags: [],
    summary: "Notes survive rewrites",
    content: "Because notes hang off the root commit, rewrites never touch them.",
    recordedAt: "2026-09-03T00:00:00.000Z",
    links: [{ rel: "derives-from", to: "01M0000000000000000000BBBB" }],
  }),
  rec({
    id: "01M0000000000000000000DDDD",
    type: "procedural",
    level: "distributed",
    namespace: "common",
    tags: ["ci"],
    summary: "Run the gate",
    content: "Run pnpm gate before tagging.",
    data: { cmd: "pnpm gate" },
    recordedAt: "2026-09-04T00:00:00.000Z",
    pinned: true,
  }),
  rec({
    id: "01M0000000000000000000EEEE",
    memoryId: "01M0000000000000000000AAAA",
    op: "tombstone",
    content: undefined,
    summary: undefined,
    reason: "obsolete",
    recordedAt: "2026-09-05T00:00:00.000Z",
  }),
];

describe("wiki generator (ADR-010)", () => {
  const { memories } = fold(records);
  const pages = generateWiki({
    memories: memories.values(),
    records,
    generatedAt: AT,
    title: "Test memory",
  });
  const goldenDir = join(import.meta.dirname, "..", "test", "golden");

  it("matches the golden pages", () => {
    const paths = pages.map((p) => p.path);
    expect(paths).toEqual([
      "entities/git-notes.md",
      "index.md",
      "log.md",
      "memories/01M0000000000000000000BBBB.md",
      "memories/01M0000000000000000000CCCC.md",
      "memories/01M0000000000000000000DDDD.md",
      "topics/ci.md",
      "topics/git.md",
    ]);
    for (const p of pages) {
      const golden = readFileSync(join(goldenDir, p.path), "utf8");
      expect(p.content, p.path).toBe(golden);
    }
  });

  it("hides tombstoned memories from index and pages but keeps them in the log", () => {
    const index = pages.find((p) => p.path === "index.md")?.content ?? "";
    expect(index).not.toMatch(/root commit/);
    expect(pages.find((p) => p.path === "log.md")?.content).toMatch(/tombstone \| obsolete/);
  });

  it("round-trips an edited memory page through parseMemoryPage", () => {
    const page =
      pages.find((p) => p.path === "memories/01M0000000000000000000DDDD.md")?.content ?? "";
    const parsed = parseMemoryPage(
      page.replace("Run pnpm gate before tagging.", "Run pnpm gate twice before tagging.")
    );
    expect(parsed).toEqual({
      memoryId: "01M0000000000000000000DDDD",
      content: "Run pnpm gate twice before tagging.",
      summary: "Run the gate",
    });
    expect(parseMemoryPage("no frontmatter")).toBeNull();
    expect(slug("entity:Git Notes!")).toBe("git-notes");
  });

  it("writes to a directory and an orphan branch and reads back the same pages", async () => {
    const dir = new DirectoryTarget(mkdtempSync(join(tmpdir(), "ynm-wiki-")));
    await dir.write(pages);
    expect(await dir.list()).toEqual(pages.map((p) => p.path));
    expect(await dir.read("index.md")).toBe(pages.find((p) => p.path === "index.md")?.content);
    await dir.write(pages.slice(0, 2));
    expect(await dir.list()).toHaveLength(2);

    const repo = await createRepo(1);
    const head = await fx(repo, "rev-parse", "HEAD");
    const branch = new OrphanBranchTarget(repo);
    await branch.write(pages);
    expect(await fx(repo, "rev-parse", "HEAD")).toBe(head);
    expect(await branch.list()).toEqual(pages.map((p) => p.path));
    expect(await branch.read("entities/git-notes.md")).toBe(
      pages.find((p) => p.path === "entities/git-notes.md")?.content
    );
    await branch.write(pages);
    expect((await fx(repo, "rev-list", "--count", "refs/heads/ynm/wiki")).trim()).toBe("2");
  });

  it.each([
    ["a page two folders deep beside a root page", ["index.md", "a/b/c.md"]],
    ["a page two folders deep with no root page", ["a/b/c.md"]],
    ["sibling folders each holding deep pages", ["index.md", "a/b/c.md", "x/y/z/w.md"]],
    ["an intermediate folder with its own page", ["index.md", "a/a.md", "a/b/c.md"]],
    ["an intermediate folder with no page of its own", ["index.md", "a/b/c.md", "a/b/d/e.md"]],
    ["deep pages sharing an ancestor", ["a/b/c/d.md", "a/b/e/f.md", "a/g.md"]],
  ])("keeps every page on the orphan branch: %s", async (_layout, paths) => {
    const repo = await createRepo(1);
    const branch = new OrphanBranchTarget(repo);
    await branch.write(paths.map((path) => ({ path, content: `# ${path}\n` })));
    expect(await branch.list()).toEqual([...paths].sort());
    for (const path of paths) expect(await branch.read(path)).toBe(`# ${path}\n`);
  });
});
