import { GitNotesLog, MemoryLog } from "@ynm/store";
import { clone, createBare, rootCommit } from "@ynm/store/testing/git";
import { DEFAULT_REDACTION } from "./config.js";
import { IndexManager } from "./indexing.js";
import { Ynm } from "./ynm.js";

describe("purge (ADR-002)", () => {
  it("removes every line, writes a purge marker, and drops the memory from recall", async () => {
    const y = new Ynm({
      mounts: [
        { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
      ],
      actor: "t",
      userId: "u",
      redaction: DEFAULT_REDACTION,
      index: new IndexManager("memory", { fileFor: () => ":memory:" }),
    });
    const { memoryId } = await y.remember({
      type: "semantic",
      content: "secret-ish thing to purge",
    });
    await y.supersede({ memoryId, content: "still to purge" });
    await y.remember({ type: "semantic", content: "keep me" });
    const r = await y.purge({ memoryId, reason: "gdpr request" });
    expect(r.removed).toBe(2);
    const records = await y.records({ includeTombstoned: true });
    expect(records.filter((x) => x.memoryId === memoryId).map((x) => x.op)).toEqual([
      "purge-marker",
    ]);
    expect(await y.find(memoryId)).toBeNull();
    expect((await y.recall({ text: "purge" })).length).toBe(0);
    expect((await y.list()).length).toBe(1);
  });
});

describe("purge without an index", () => {
  it("records that history was dropped in the marker reason", async () => {
    const y = new Ynm({
      mounts: [
        { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
      ],
      actor: "t",
      userId: "u",
      redaction: DEFAULT_REDACTION,
    });
    const { memoryId } = await y.remember({ type: "semantic", content: "drop all of it" });
    const r = await y.purge({ memoryId, reason: "erasure", forgetHistory: true });
    expect(r).toEqual({ memoryId, removed: 1, mount: "personal" });
    const [marker] = await y.records({ includeTombstoned: true });
    expect(marker?.op).toBe("purge-marker");
    expect(marker?.reason).toBe("erasure (history dropped)");
  });
});

describe("purge across clones (ynm #175)", () => {
  async function pair() {
    const origin = await createBare();
    const anchor = await rootCommit(origin);
    const open = async () => {
      const repo = await clone(origin);
      const log = new GitNotesLog("d", "distributed", { repo, anchor });
      const ynm = new Ynm({
        mounts: [{ id: "project", level: "distributed", location: repo, log }],
        actor: "t",
        userId: "u",
        redaction: DEFAULT_REDACTION,
      });
      return { ynm, log };
    };
    return { a: await open(), b: await open() };
  }

  it("keeps a purged memory purged when another clone wrote to the same shard before syncing", async () => {
    const { a, b } = await pair();
    const { memoryId } = await a.ynm.remember({
      type: "semantic",
      level: "distributed",
      content: "contained personal data",
    });
    await a.ynm.sync();
    await b.ynm.sync();
    // b writes to the same shard while a purges.
    await b.ynm.remember({ type: "semantic", level: "distributed", content: "unrelated note" });
    await a.ynm.purge({ memoryId, reason: "contained personal data" });
    await a.ynm.sync();
    await b.ynm.sync();
    await a.ynm.sync();
    for (const { ynm, log } of [a, b]) {
      expect(await ynm.find(memoryId)).toBeNull();
      expect((await ynm.list()).map((m) => m.memoryId)).not.toContain(memoryId);
      expect(
        (await ynm.records({ includeTombstoned: true }))
          .filter((r) => r.memoryId === memoryId)
          .map((r) => r.op)
      ).toEqual(["purge-marker"]);
      const lines: string[] = [];
      for await (const r of log.scan()) if (r.memoryId === memoryId) lines.push(r.op);
      expect(lines).toEqual(["purge-marker"]);
    }
    expect((await a.ynm.list()).length).toBe(1);
  });

  it("hides the lines when they are restored behind a clone's back", async () => {
    const { a, b } = await pair();
    const { memoryId } = await a.ynm.remember({
      type: "semantic",
      level: "distributed",
      content: "contained personal data",
    });
    await a.ynm.sync();
    await b.ynm.sync();
    await b.ynm.remember({ type: "semantic", level: "distributed", content: "unrelated note" });
    await a.ynm.purge({ memoryId, reason: "gdpr" });
    // Without the service's sync (and so its scrub), the store alone unions the lines back.
    await a.log.sync();
    await b.log.sync();
    await a.log.sync();
    expect(await b.ynm.find(memoryId)).toBeNull();
    expect(
      (await b.ynm.records({ includeTombstoned: true })).filter((r) => r.memoryId === memoryId)
    ).toHaveLength(1);
  });
});
