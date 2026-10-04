import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo, fx } from "@ynm/store/testing/git";
import { DirectoryTarget, OrphanBranchTarget } from "./targets.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ynm-wiki-target-"));
}

describe("DirectoryTarget", () => {
  it("lists nothing and reads null before anything is written", async () => {
    const t = new DirectoryTarget(join(tmp(), "not-yet"));
    expect(await t.list()).toEqual([]);
    expect(await t.read("index.md")).toBeNull();
  });

  it("creates the directory on first write and nested folders as needed", async () => {
    const dir = join(tmp(), "wiki");
    const t = new DirectoryTarget(dir);
    expect(await t.write([{ path: "a/b/c.md", content: "deep" }])).toEqual({
      written: 1,
      location: dir,
    });
    expect(existsSync(join(dir, "a", "b", "c.md"))).toBe(true);
    expect(await t.read("a/b/c.md")).toBe("deep");
  });

  it("ignores and keeps files that are not markdown", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".obsidian"));
    writeFileSync(join(dir, ".obsidian", "app.json"), "{}");
    writeFileSync(join(dir, "image.png"), "png");
    const t = new DirectoryTarget(dir);
    await t.write([{ path: "index.md", content: "i" }]);
    expect(await t.list()).toEqual(["index.md"]);
    await t.write([]);
    expect(await t.list()).toEqual([]);
    expect(existsSync(join(dir, "image.png"))).toBe(true);
    expect(existsSync(join(dir, ".obsidian", "app.json"))).toBe(true);
  });
});

describe("OrphanBranchTarget", () => {
  it("reads null and lists nothing before the branch exists", async () => {
    const repo = await createRepo(1);
    const t = new OrphanBranchTarget(repo, "wiki/custom");
    expect(await t.list()).toEqual([]);
    expect(await t.read("index.md")).toBeNull();
  });

  it("commits an empty tree when there are no pages", async () => {
    const repo = await createRepo(1);
    const t = new OrphanBranchTarget(repo, "wiki/custom");
    expect(await t.write([])).toEqual({ written: 0, location: `${repo}#wiki/custom` });
    expect(await t.list()).toEqual([]);
    const tree = (await fx(repo, "rev-parse", "refs/heads/wiki/custom^{tree}")).trim();
    expect(tree).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  it("builds intermediate trees for a page nested two levels deep", async () => {
    const repo = await createRepo(1);
    const t = new OrphanBranchTarget(repo);
    await t.write([{ path: "a/b/c.md", content: "deep" }]);
    expect(await t.list()).toEqual(["a/b/c.md"]);
    expect(await t.read("a/b/c.md")).toBe("deep");
  });

  it("lists only markdown files", async () => {
    const repo = await createRepo(1);
    const t = new OrphanBranchTarget(repo);
    await t.write([
      { path: "index.md", content: "i" },
      { path: "assets/logo.svg", content: "<svg/>" },
    ]);
    expect(await t.list()).toEqual(["index.md"]);
    expect(await t.read("assets/logo.svg")).toBe("<svg/>");
  });
});
