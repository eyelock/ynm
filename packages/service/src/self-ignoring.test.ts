import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRepo, fx, tempDir } from "@ynm/store/testing/git";
import { initProject } from "./init.js";
import { openYnm } from "./open.js";
import { buildWiki } from "./wiki.js";

/** A clone of a repository whose `.ynm/config.json` is committed, where `ynm init` never ran. */
async function freshClone(): Promise<{ clone: string; env: Record<string, string> }> {
  const repo = await createRepo(2);
  await initProject({ cwd: repo, hooks: false });
  await fx(repo, "add", ".ynm/config.json");
  await fx(repo, "commit", "-m", "add ynm config");
  const clone = join(tempDir("ynm-clone-"), "clone");
  await fx(repo, "clone", repo, clone);
  return { clone, env: { YNM_HOME: join(tempDir("ynm-home-"), ".ynm"), YNM_USER: "david" } };
}

const status = (repo: string): Promise<string> => fx(repo, "status", "--porcelain", "-uall");

describe("derived folders ignore themselves in every clone", () => {
  it("leaves nothing under .ynm/index untracked after the index is built, without init", async () => {
    const { clone, env } = await freshClone();
    expect(existsSync(join(clone, ".git", "info", "exclude"))).toBe(true);
    expect(readFileSync(join(clone, ".git", "info", "exclude"), "utf8")).not.toMatch(/\.ynm/);
    const { ynm } = await openYnm({ cwd: clone, env });
    await ynm.remember({ type: "semantic", level: "distributed", content: "shared fact" });
    await ynm.recall({ text: "shared" });
    expect(existsSync(join(clone, ".ynm", "index", "project.sqlite"))).toBe(true);
    expect(readFileSync(join(clone, ".ynm", "index", ".gitignore"), "utf8")).toBe("*\n");
    expect(await status(clone)).toBe("");
  });

  it("heals an index folder that predates the .gitignore", async () => {
    const { clone, env } = await freshClone();
    mkdirSync(join(clone, ".ynm", "index"), { recursive: true });
    const { ynm } = await openYnm({ cwd: clone, env });
    await ynm.recall({ text: "anything" });
    expect(existsSync(join(clone, ".ynm", "index", ".gitignore"))).toBe(true);
    expect(await status(clone)).toBe("");
  });

  it("leaves nothing under the default wiki folder untracked, without init", async () => {
    const { clone, env } = await freshClone();
    const { ynm } = await openYnm({ cwd: clone, env });
    await ynm.remember({ type: "semantic", level: "distributed", content: "wiki fact" });
    await buildWiki(ynm, { mount: "project", home: env.YNM_HOME as string, repo: clone });
    expect(existsSync(join(clone, ".ynm", "wiki", "index.md"))).toBe(true);
    expect(readFileSync(join(clone, ".ynm", "wiki", ".gitignore"), "utf8")).toBe("*\n");
    expect(await status(clone)).toBe("");
  });

  it("does not write a .gitignore into a wiki directory the user chose", async () => {
    const { clone, env } = await freshClone();
    const { ynm } = await openYnm({ cwd: clone, env });
    await ynm.remember({ type: "semantic", level: "distributed", content: "wiki fact" });
    const vault = tempDir("ynm-vault-");
    await buildWiki(ynm, {
      mount: "project",
      home: env.YNM_HOME as string,
      repo: clone,
      dir: vault,
    });
    expect(existsSync(join(vault, ".gitignore"))).toBe(false);
  });
});
