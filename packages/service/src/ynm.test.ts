import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryLog } from "@ynm/store";
import { DEFAULT_REDACTION } from "./config.js";
import { Ynm } from "./ynm.js";

function make(withProject = true): Ynm {
  const mounts = [
    {
      id: "personal",
      level: "personal" as const,
      location: "mem",
      log: new MemoryLog("personal", "personal"),
    },
  ];
  if (withProject)
    mounts.push({
      id: "project",
      level: "distributed" as const,
      location: "mem",
      log: new MemoryLog("project", "distributed"),
    });
  return new Ynm({ mounts, actor: "test", userId: "david", redaction: DEFAULT_REDACTION });
}

describe("Ynm service", () => {
  it("remembers into the personal mount with user namespace by default", async () => {
    const y = make();
    const r = await y.remember({ type: "semantic", content: "# Anchor\nRoot commit." });
    expect(r.mount).toBe("personal");
    const [m] = await y.list();
    expect(m?.namespace).toBe("user/david");
    expect(m?.current.summary).toBe("Anchor");
    expect(m?.current.provenance.actor).toBe("test");
  });

  it("routes distributed records to the project mount", async () => {
    const y = make();
    const r = await y.remember({
      type: "procedural",
      level: "distributed",
      content: "Run pnpm check before push.",
    });
    expect(r.mount).toBe("project");
    expect((await y.list({ level: "distributed", includeTombstoned: false }))[0]?.namespace).toBe(
      "common"
    );
  });

  it("fails clearly when no distributed mount exists", async () => {
    await expect(
      make(false).remember({ type: "semantic", level: "distributed", content: "x" })
    ).rejects.toThrow(/ynm init/);
  });

  it("supersede, annotate and forget fold as expected", async () => {
    const y = make();
    const { memoryId } = await y.remember({ type: "semantic", content: "v1", tags: ["a"] });
    await y.supersede({ memoryId, content: "v2", tags: ["b"] });
    await y.annotate({ memoryId, pinned: true, importance: 0.9 });
    let [m] = await y.list();
    expect(m?.current.content).toBe("v2");
    expect(m?.tags).toEqual(["a", "b"]);
    expect(m?.pinned).toBe(true);
    expect(m?.importance).toBe(0.9);
    expect(m?.versions).toBe(3);
    await y.forget({ memoryId, reason: "obsolete" });
    expect(await y.list()).toHaveLength(0);
    [m] = await y.list({ includeTombstoned: true });
    expect(m?.tombstoned).toBe(true);
  });

  it("refuses distributed writes that contain secrets (ADR-007)", async () => {
    const y = make();
    await expect(
      y.remember({
        type: "semantic",
        level: "distributed",
        content: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234",
      })
    ).rejects.toThrow(/redaction/);
    await expect(
      y.remember({ type: "semantic", content: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234" })
    ).resolves.toBeTruthy();
  });

  it("promotes a personal memory as a new distributed record linked derives-from", async () => {
    const y = make();
    const { memoryId } = await y.remember({ type: "procedural", content: "Always run the gate." });
    const p = await y.promote(memoryId);
    expect(p.mount).toBe("project");
    const shared = (await y.list({ level: "distributed", includeTombstoned: false }))[0];
    expect(shared?.namespace).toBe("common");
    expect(shared?.links).toEqual([{ rel: "derives-from", to: memoryId }]);
    expect((await y.list({ level: "personal", includeTombstoned: false }))[0]?.memoryId).toBe(
      memoryId
    );
    await expect(y.promote(p.memoryId)).rejects.toThrow(/already distributed/);
  });

  it("exports and imports JSONL, routing by level and reporting bad lines", async () => {
    const y = make();
    await y.remember({ type: "semantic", content: "one" });
    await y.remember({ type: "semantic", level: "distributed", content: "two" });
    const text = await y.exportJsonl();
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
    const z = make();
    const res = await z.importJsonl(`${text}garbage\n`);
    expect(res.imported).toBe(2);
    expect(res.problems).toHaveLength(1);
    expect(await z.list()).toHaveLength(2);
  });

  it("lists newest first with filters and limit", async () => {
    let t = 0;
    const y = new Ynm({
      mounts: [
        { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
      ],
      actor: "t",
      userId: "u",
      redaction: [],
      now: () => new Date(1_800_000_000_000 + ++t * 1000),
    });
    await y.remember({ type: "semantic", content: "a" });
    await y.remember({ type: "episodic", content: "b" });
    await y.remember({ type: "semantic", content: "c" });
    expect((await y.list()).map((m) => m.current.content)).toEqual(["c", "b", "a"]);
    expect(
      (await y.list({ type: "semantic", includeTombstoned: false, limit: 1 })).map(
        (m) => m.current.content
      )
    ).toEqual(["c"]);
  });

  it("sync only touches distributed mounts unless one is named", async () => {
    const y = make();
    expect(await y.sync()).toEqual({});
    expect((await y.status()).mounts.map((m) => m.id)).toEqual(["personal", "project"]);
  });

  it("reports the temp dir helper works for later tests", () => {
    expect(mkdtempSync(join(tmpdir(), "ynm-svc-"))).toBeTruthy();
  });
});
