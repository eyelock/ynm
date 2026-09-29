import { MemoryLog } from "@ynm/store";
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
