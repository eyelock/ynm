import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBare, createRepo, fx } from "@ynm/store/testing/git";
import { ynm } from "../../test/helpers.js";

function hitsIdOf(hits: Array<{ memoryId?: string }>): string {
  return hits[0]?.memoryId ?? "";
}

describe("ynm CLI workflow on real git repos", () => {
  it("init, remember, list, supersede, annotate, forget, export, import, promote, doctor", async () => {
    const origin = await createBare();
    const repo = await createRepo(2);
    await fx(repo, "remote", "add", "origin", origin);

    let r = ynm(repo, "init", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).anchorSource).toBe("root-commit");

    r = ynm(
      repo,
      "remember",
      "--type",
      "semantic",
      "--content",
      "Notes anchor to the root commit",
      "--tags",
      "git",
      "--json"
    );
    expect(r.status, r.stderr).toBe(0);
    const personal = JSON.parse(r.stdout) as { memoryId: string; mount: string };
    expect(personal.mount).toBe("personal");

    r = ynm(
      repo,
      "remember",
      "--type",
      "procedural",
      "--level",
      "distributed",
      "--content",
      "Run pnpm check before pushing",
      "--json"
    );
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).mount).toBe("project");

    r = ynm(
      repo,
      "remember",
      "--type",
      "semantic",
      "--level",
      "distributed",
      "--content",
      "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refused/);

    r = ynm(
      repo,
      "supersede",
      "--memory-id",
      personal.memoryId,
      "--content",
      "Notes anchor to the oldest root commit",
      "--json"
    );
    expect(r.status, r.stderr).toBe(0);
    r = ynm(
      repo,
      "annotate",
      "--memory-id",
      personal.memoryId,
      "--pinned",
      "--importance",
      "0.9",
      "--json"
    );
    expect(r.status, r.stderr).toBe(0);

    r = ynm(repo, "list", "--json");
    const listed = JSON.parse(r.stdout) as Array<{
      memoryId: string;
      pinned: boolean;
      current: { content: string };
      mount: string;
    }>;
    expect(listed).toHaveLength(2);
    const mine = listed.find((m) => m.memoryId === personal.memoryId);
    expect(mine?.pinned).toBe(true);
    expect(mine?.current.content).toMatch(/oldest root/);

    r = ynm(repo, "promote", personal.memoryId, "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).mount).toBe("project");

    r = ynm(repo, "export");
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n").filter(Boolean);
    expect(lines.length).toBe(5);

    r = ynm(repo, "forget", "--memory-id", personal.memoryId, "--reason", "test", "--json");
    expect(r.status, r.stderr).toBe(0);
    r = ynm(repo, "list", "--level", "personal", "--json");
    expect(JSON.parse(r.stdout)).toHaveLength(0);
    r = ynm(repo, "list", "--level", "personal", "--include-tombstoned", "--json");
    expect(JSON.parse(r.stdout)).toHaveLength(1);

    const file = join(mkdtempSync(join(tmpdir(), "ynm-imp-")), "m.jsonl");
    writeFileSync(file, `${lines[1]}\nnot json\n`);
    r = ynm(repo, "import", file, "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).problems).toHaveLength(1);

    r = ynm(repo, "sync", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).project.pushed.length).toBeGreaterThan(0);
    const remoteRefs = await fx(origin, "for-each-ref", "--format=%(refname)", "refs/notes/");
    expect(remoteRefs).toMatch(/ynm\/distributed/);
    expect(remoteRefs).not.toMatch(/personal/);

    r = ynm(repo, "sync", "--mount", "personal");
    expect(r.status).toBe(2);

    r = ynm(repo, "doctor", "--json");
    expect(r.status, r.stdout).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);

    r = ynm(repo, "status");
    expect(r.stdout).toMatch(/project\s+distributed/);

    r = ynm(repo, "recall", "--text", "pnpm check", "--json");
    expect(r.status, r.stderr).toBe(0);
    const hits = JSON.parse(r.stdout) as Array<{
      memoryId: string;
      mount: string;
      content: string;
    }>;
    expect(hits[0]?.content).toMatch(/pnpm check/);
    r = ynm(repo, "context", "--budget-tokens", "200");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^## Memory/);
    r = ynm(repo, "reindex", "--json");
    expect(r.status, r.stderr).toBe(0);
    r = ynm(repo, "pin", hitsIdOf(hits), "--json");
    expect(r.status, r.stderr).toBe(0);
    r = ynm(repo, "recall", "--pinned-only", "--json");
    expect(JSON.parse(r.stdout)).toHaveLength(1);
  });
});
