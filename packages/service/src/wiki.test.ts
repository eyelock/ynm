import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryLog } from "@ynm/store";
import { createRepo, fx, tempDir } from "@ynm/store/testing/git";
import { DEFAULT_REDACTION } from "./config.js";
import { IndexManager } from "./indexing.js";
import { openConfiguredMount } from "./mounts.js";
import { buildWiki, defaultWikiDir, ingestWikiPage, wikiPages, wikiTarget } from "./wiki.js";
import { Ynm } from "./ynm.js";

/** The body copy, not the page title that precedes it. */
const LAST_TUESDAYS = /Tuesdays(?![\s\S]*Tuesdays)/;

function makeYnm(): Ynm {
  return new Ynm({
    mounts: [
      { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
    ],
    actor: "t",
    userId: "u",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
  });
}

async function pageFor(y: Ynm, memoryId: string): Promise<string> {
  const mount = y.mounts[0];
  if (!mount) throw new Error("no mount");
  const pages = await wikiPages(y, mount);
  return pages.find((p) => p.path === `memories/${memoryId}.md`)?.content ?? "";
}

describe("wiki ingest", () => {
  it("derives a fresh summary when the content changed and the title was not edited", async () => {
    const y = makeYnm();
    const { memoryId } = await y.remember({ type: "semantic", content: "Standup is on Tuesdays" });
    const page = await pageFor(y, memoryId);
    const res = await ingestWikiPage(y, page.replace(LAST_TUESDAYS, "Wednesdays"));
    expect(res.changed).toBe(true);
    const m = await y.find(memoryId);
    expect(m?.current.content).toBe("Standup is on Wednesdays");
    expect(m?.current.summary).toBe("Standup is on Wednesdays");
  });

  it("keeps an explicitly edited page title as the summary", async () => {
    const y = makeYnm();
    const { memoryId } = await y.remember({ type: "semantic", content: "Standup is on Tuesdays" });
    const page = await pageFor(y, memoryId);
    const edited = page
      .replace(LAST_TUESDAYS, "Wednesdays")
      .replace("# Standup is on Tuesdays", "# Standup day");
    await ingestWikiPage(y, edited);
    expect((await y.find(memoryId))?.current.summary).toBe("Standup day");
  });
});

describe("wiki ingest refusals", () => {
  it("rejects text that is not a memory page", async () => {
    await expect(ingestWikiPage(makeYnm(), "# Just a heading\n")).rejects.toThrow(
      /not a memory page/
    );
  });

  it("rejects a page for a memory the store does not hold", async () => {
    const page = `---\nmemoryId: 01M0000000000000000000ZZZZ\n---\n# Ghost\n\nNobody remembers this\n`;
    await expect(ingestWikiPage(makeYnm(), page)).rejects.toThrow(
      /unknown memory 01M0000000000000000000ZZZZ/
    );
  });

  it("reports no change when the page body matches the stored content", async () => {
    const y = makeYnm();
    const { memoryId } = await y.remember({ type: "semantic", content: "Standup is on Tuesdays" });
    const res = await ingestWikiPage(y, await pageFor(y, memoryId));
    expect(res).toEqual({ memoryId, changed: false });
    expect((await y.records()).filter((r) => r.memoryId === memoryId)).toHaveLength(1);
  });
});

describe("wiki targets and build", () => {
  const personal = {
    id: "personal",
    level: "personal" as const,
    location: "mem",
    log: new MemoryLog("p", "personal"),
  };
  const project = {
    id: "project",
    level: "distributed" as const,
    location: "mem",
    log: new MemoryLog("q", "distributed"),
  };

  it("puts the project wiki inside the repo and every other mount under home", () => {
    expect(defaultWikiDir(project, "/h", "/r")).toBe(join("/r", ".ynm", "wiki"));
    expect(defaultWikiDir(project, "/h")).toBe(join("/h", "wiki", "project"));
    expect(defaultWikiDir(personal, "/h", "/r")).toBe(join("/h", "wiki", "personal"));
  });

  it("prefers an explicit directory and refuses an orphan branch outside git", () => {
    const explicit = wikiTarget(personal, { home: "/h", dir: "/elsewhere" });
    expect(explicit.name).toBe("directory");
    expect(() => wikiTarget(personal, { home: "/h", target: "orphan-branch" })).toThrow(
      /not a git repository/
    );
  });

  it("writes every mount, or only the named one, to its directory", async () => {
    const y = new Ynm({
      mounts: [
        { ...personal, log: new MemoryLog("p", "personal") },
        { ...project, log: new MemoryLog("q", "distributed") },
      ],
      actor: "t",
      userId: "u",
      redaction: DEFAULT_REDACTION,
    });
    const { memoryId } = await y.remember({ type: "semantic", content: "Deploys run on Fridays" });
    const home = tempDir("ynm-wiki-home-");
    const all = await buildWiki(y, { home });
    expect(all.map((r) => r.mount)).toEqual(["personal", "project"]);
    expect(all[0]?.location).toBe(join(home, "wiki", "personal"));
    expect(all[0]?.written).toBeGreaterThan(all[1]?.written ?? 0);
    expect(
      readFileSync(join(home, "wiki", "personal", "memories", `${memoryId}.md`), "utf8")
    ).toContain("Deploys run on Fridays");

    const dir = tempDir("ynm-wiki-dir-");
    const one = await buildWiki(y, { home, mount: "project", dir });
    expect(one).toEqual([{ mount: "project", written: one[0]?.written, location: dir }]);
    expect(existsSync(join(dir, "memories", `${memoryId}.md`))).toBe(false);
  });

  it("commits the pages to an orphan branch of a git-notes mount", async () => {
    const repo = await createRepo(1);
    const mount = await openConfiguredMount({
      id: "org",
      level: "distributed",
      provider: "git-notes",
      path: repo,
    });
    const y = new Ynm({ mounts: [mount], actor: "t", userId: "u", redaction: DEFAULT_REDACTION });
    const { memoryId } = await y.remember({
      type: "semantic",
      level: "distributed",
      content: "The org wiki lives on a branch",
    });
    const [res] = await buildWiki(y, { home: tempDir(), target: "orphan-branch" });
    expect(res?.location).toBe(`${repo}#ynm/wiki`);
    const files = await fx(repo, "ls-tree", "-r", "--name-only", "ynm/wiki");
    expect(files).toContain(`memories/${memoryId}.md`);
  });
});
