import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ynm } from "../../test/helpers.js";

function repoWithoutRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), "ynm-sync-"));
  const run = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", dir, ...args], {
      encoding: "utf8",
    });
  run("init", "-q", "-b", "main");
  run("commit", "-q", "--allow-empty", "-m", "first");
  return dir;
}

describe("ynm sync", () => {
  it("reports a missing remote and exits 0", () => {
    const dir = repoWithoutRemote();
    expect(ynm(dir, "init", "--no-hooks").status).toBe(0);
    const r = ynm(dir, "sync");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('project: remote "origin" not configured; nothing to sync');
  });
});
