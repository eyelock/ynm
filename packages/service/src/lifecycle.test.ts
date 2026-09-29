import { MemoryLog } from "@ynm/store";
import { DEFAULT_REDACTION } from "./config.js";
import { IndexManager } from "./indexing.js";
import { durationMs, Lifecycle } from "./lifecycle.js";
import { Ynm } from "./ynm.js";

describe("lifecycle (sessions and expire pass)", () => {
  let t = Date.parse("2026-09-29T00:00:00.000Z");
  const now = () => new Date(t);
  const ynm = new Ynm({
    mounts: [
      { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
    ],
    actor: "t",
    userId: "u",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
    now,
  });
  const life = new Lifecycle(ynm, now);

  it("parses durations", () => {
    expect(durationMs("PT1H")).toBe(3_600_000);
    expect(durationMs("P1D")).toBe(86_400_000);
    expect(() => durationMs("1h")).toThrow();
  });

  it("starts a session with a context block and a session namespace", async () => {
    const s = await life.start({});
    expect(s.namespace).toBe(`session/${s.sessionId}`);
    expect(s.context.markdown).toMatch(/^## Memory/);
  });

  it("expires working memory after its ttl, and end runs the pass", async () => {
    const s = await life.start({ sessionId: "abc" });
    await ynm.remember({
      type: "working",
      namespace: s.namespace,
      content: "scratch",
      ttl: "PT1H",
    });
    await ynm.remember({ type: "semantic", content: "keep" });
    t += 30 * 60_000;
    expect((await life.consolidate({ dryRun: true })).passes.expire?.changed).toEqual([]);
    t += 31 * 60_000;
    const dry = await life.consolidate({ dryRun: true });
    expect(dry.passes.expire?.changed).toHaveLength(1);
    expect((await ynm.list({ type: "working", includeTombstoned: false })).length).toBe(1);
    const end = await life.end({ sessionId: "abc" });
    expect(end.expired).toHaveLength(1);
    expect((await ynm.list({ type: "working", includeTombstoned: false })).length).toBe(0);
    expect((await ynm.list({ type: "semantic", includeTombstoned: false })).length).toBe(1);
  });
});
