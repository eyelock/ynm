import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBare, createRepo, fx } from "@ynm/store/testing/git";
import { detectWorktree } from "./worktree.js";

describe("detectWorktree", () => {
  it("reports a plain repo", async () => {
    const repo = await createRepo(1);
    const info = await detectWorktree(repo);
    expect(info).toMatchObject({ isGitRepo: true, isWorktree: false, isBare: false });
    expect(info.mainRepoPath).toBe(info.currentPath);
  });
  it("reports a linked worktree with the main repo path", async () => {
    const repo = await createRepo(1);
    const wt = join(mkdtempSync(join(tmpdir(), "ynm-wt-")), "wt");
    await fx(repo, "worktree", "add", "-q", wt, "-b", "feature");
    const info = await detectWorktree(wt);
    expect(info.isWorktree).toBe(true);
    expect(info.mainRepoPath).toBe((await detectWorktree(repo)).mainRepoPath);
  });
  it("reports a bare repo", async () => {
    const bare = await createBare();
    expect((await detectWorktree(bare)).isBare).toBe(true);
  });
  it("reports a non-repo", async () => {
    expect((await detectWorktree(mkdtempSync(join(tmpdir(), "ynm-nogit-")))).isGitRepo).toBe(false);
  });
});
