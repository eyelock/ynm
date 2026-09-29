import { DEFAULT_REDACTION, IndexManager, Ynm } from "@ynm/service";
import { MemoryLog } from "@ynm/store";
import { parseEvery, startScheduler } from "./scheduler.js";

let clock = Date.parse("2026-09-29T00:00:00.000Z");

function make(): Ynm {
  return new Ynm({
    now: () => new Date(clock),
    mounts: [
      { id: "org", level: "distributed", location: "mem", log: new MemoryLog("o", "distributed") },
    ],
    actor: "sched",
    userId: "sched",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
  });
}

describe("hosted scheduler (ADR-009)", () => {
  it("parses intervals", () => {
    expect(parseEvery("15m")).toBe(900_000);
    expect(parseEvery("2s")).toBe(2000);
    expect(parseEvery("250")).toBe(250);
    expect(parseEvery(undefined)).toBe(0);
    expect(() => parseEvery("soon")).toThrow(/bad interval/);
  });

  it("runs the expire pass on a timer, never overlapping, and reports stats", async () => {
    const ynm = make();
    await ynm.remember({
      type: "working",
      level: "distributed",
      content: "scratch",
      ttl: "PT1S",
      namespace: "session/s1",
    });
    clock += 5_000;
    const h = startScheduler(async () => ynm, {
      dreamEveryMs: 20,
      quiet: true,
      now: () => new Date(clock),
    });
    await new Promise((r) => setTimeout(r, 120));
    h.stop();
    expect(h.stats.dreamRuns).toBeGreaterThanOrEqual(2);
    expect(h.stats.lastDream?.expire?.changed).toBe(0);
    expect((await ynm.list({ type: "working" })).length).toBe(0);
    await h.dreamNow();
    expect(h.stats.lastDreamAt).toBe(new Date(clock).toISOString());
  });

  it("records a failing run and keeps going", async () => {
    let calls = 0;
    const h = startScheduler(
      async () => {
        calls += 1;
        throw new Error("store offline");
      },
      { quiet: true }
    );
    await h.dreamNow();
    await h.syncNow();
    expect(calls).toBe(2);
    expect(h.stats.lastError).toMatch(/store offline/);
    expect(h.stats.dreamRuns).toBe(0);
    h.stop();
  });
});
