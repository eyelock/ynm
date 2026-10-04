import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRepo, rootCommit, tempDir } from "@ynm/store/testing/git";
import { YnmConfigSchema } from "./config.js";
import { loadStoreS3, openConfiguredMount, openMounts, projectInitialised } from "./mounts.js";
import type { WorktreeInfo } from "./worktree.js";

describe("openConfiguredMount", () => {
  it("computes the anchor of a notes mount that configures none", async () => {
    const repo = await createRepo(2);
    const mount = await openConfiguredMount({
      id: "org",
      level: "distributed",
      provider: "git-notes",
      path: repo,
    });
    expect(mount.id).toBe("org");
    const anchor = await rootCommit(repo);
    const record = {
      v: 1,
      id: "01M0000000000000000000AAAA",
      memoryId: "01M0000000000000000000AAAA",
      op: "create",
      type: "semantic",
      level: "distributed",
      namespace: "common",
      tags: [],
      content: "anchored without config",
      recordedAt: "2026-09-01T00:00:00.000Z",
      provenance: { actor: "test" },
      links: [],
    } as const;
    await mount.log.append([record]);
    const seen: string[] = [];
    for await (const r of mount.log.scan()) seen.push(r.id);
    expect(seen).toEqual([record.id]);
    expect(anchor).toMatch(/^[0-9a-f]{40}/);
  });

  it("keeps a configured anchor", async () => {
    const repo = await createRepo(1);
    const anchor = await rootCommit(repo);
    const mount = await openConfiguredMount({
      id: "org",
      level: "distributed",
      provider: "git-notes",
      path: repo,
      anchor,
    });
    expect(mount.location).toBe(repo);
  });
});

describe("openConfiguredMount providers", () => {
  it("opens fs, memory and sqlite mounts by provider", async () => {
    const dir = tempDir("ynm-mounts-");
    const fs = await openConfiguredMount({ id: "a", level: "personal", provider: "fs", path: dir });
    expect(fs.log.provider).toBe("fs");
    const mem = await openConfiguredMount({
      id: "b",
      level: "distributed",
      provider: "memory",
      path: dir,
    });
    expect(mem.log.provider).toBe("memory");
    expect(mem.level).toBe("distributed");
    for (const path of [dir, join(dir, "custom.sqlite")]) {
      const sq = await openConfiguredMount({
        id: "c",
        level: "personal",
        provider: "sqlite",
        path,
      });
      expect(sq.log.provider).toBe("sqlite");
      expect((await sq.log.health()).ok).toBe(true);
    }
    expect(existsSync(join(dir, "store.sqlite"))).toBe(true);
    expect(existsSync(join(dir, "custom.sqlite"))).toBe(true);
  });
});

describe("openMounts", () => {
  function worktreeAt(path: string, isGitRepo = true): WorktreeInfo {
    return {
      isGitRepo,
      isWorktree: false,
      isBare: false,
      mainRepoPath: path,
      currentPath: path,
      gitCommonDir: join(path, ".git"),
      gitDir: join(path, ".git"),
    };
  }

  it("mounts personal and project stores under a non-git provider, then configured mounts", async () => {
    const home = tempDir("ynm-home-");
    const repo = tempDir("ynm-repo-");
    mkdirSync(join(repo, ".ynm"));
    writeFileSync(join(repo, ".ynm", "config.json"), "{}");
    const extra = tempDir("ynm-extra-");
    const config = YnmConfigSchema.parse({
      provider: "fs",
      mounts: [{ id: "org", level: "distributed", provider: "fs", path: extra }],
    });
    const mounts = await openMounts({
      loaded: { config, files: [], home },
      worktree: worktreeAt(repo),
    });
    expect(mounts.map((m) => [m.id, m.level, m.log.provider, m.location])).toEqual([
      ["personal", "personal", "fs", join(home, "store-fs")],
      ["project", "distributed", "fs", join(repo, ".ynm", "store-fs")],
      ["org", "distributed", "fs", extra],
    ]);
  });

  it("skips personal on request and project when the repo is not initialised", async () => {
    const repo = tempDir("ynm-repo-");
    const config = YnmConfigSchema.parse({ provider: "memory" });
    const loaded = { config, files: [], home: tempDir("ynm-home-") };
    expect(await openMounts({ loaded, worktree: worktreeAt(repo), noPersonal: true })).toEqual([]);
    expect(projectInitialised(worktreeAt(repo, false))).toBe(false);
    const personalOnly = await openMounts({ loaded, worktree: worktreeAt(repo) });
    expect(personalOnly.map((m) => m.id)).toEqual(["personal"]);
  });
});

describe("s3 mounts", () => {
  it("opens an s3 mount from bucket, prefix and region, loading the provider on demand", async () => {
    const mount = await openConfiguredMount({
      id: "hosted",
      level: "distributed",
      provider: "s3",
      bucket: "ynm-store",
      prefix: "clients/one",
      region: "eu-west-2",
    });
    expect(mount.log.provider).toBe("s3");
    expect(mount.location).toBe("s3://ynm-store/clients/one");
    const bare = await openConfiguredMount({
      id: "root",
      level: "personal",
      provider: "s3",
      bucket: "b",
    });
    expect(bare.location).toBe("s3://b/");
  });

  it("refuses an s3 mount without a bucket and another mount without a path", async () => {
    await expect(
      openConfiguredMount({ id: "x", level: "personal", provider: "s3" })
    ).rejects.toThrow(/mount x: the s3 provider needs a bucket/);
    await expect(
      openConfiguredMount({ id: "y", level: "personal", provider: "fs" })
    ).rejects.toThrow(/mount y: the fs provider needs a path/);
  });

  it("says plainly when this build lacks the s3 provider", async () => {
    const missing = Object.assign(new Error("Cannot find package '@ynm/store-s3'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    await expect(loadStoreS3("hosted", () => Promise.reject(missing))).rejects.toThrow(
      /mount hosted: this build of ynm does not include the s3 provider/
    );
    await expect(loadStoreS3("hosted", () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom"
    );
  });
});
