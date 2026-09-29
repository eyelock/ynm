import { createRepo, rootCommit } from "@ynm/store/testing/git";
import { openConfiguredMount } from "./mounts.js";

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
