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
    // Wait for two runs rather than a fixed time: a busy machine makes each run slower.
    await vi.waitFor(() => expect(h.stats.dreamRuns).toBeGreaterThanOrEqual(2), {
      timeout: 5_000,
      interval: 10,
    });
    h.stop();
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

  describe("on fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("syncs on its own interval, records the time, and stops cleanly", async () => {
      let syncs = 0;
      const fake = {
        sync: async () => {
          syncs += 1;
        },
      } as unknown as Ynm;
      const at = new Date("2026-09-30T12:00:00.000Z");
      const h = startScheduler(async () => fake, { syncEveryMs: 1000, quiet: true, now: () => at });
      await vi.advanceTimersByTimeAsync(3500);
      expect(syncs).toBe(3);
      expect(h.stats.syncRuns).toBe(3);
      expect(h.stats.lastSyncAt).toBe(at.toISOString());
      expect(h.stats.dreamRuns).toBe(0);
      h.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(syncs).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("never overlaps a slow sync: a tick during a run joins it", async () => {
      let started = 0;
      let release: () => void = () => {};
      const fake = {
        sync: () => {
          started += 1;
          return new Promise<void>((r) => {
            release = r;
          });
        },
      } as unknown as Ynm;
      const h = startScheduler(async () => fake, { syncEveryMs: 100, quiet: true });
      await vi.advanceTimersByTimeAsync(450);
      expect(started).toBe(1);
      const joined = h.syncNow();
      release();
      await joined;
      expect(h.stats.syncRuns).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(started).toBe(2);
      release();
      h.stop();
    });

    it("zero or missing intervals start no timers", () => {
      const h = startScheduler(async () => make(), { dreamEveryMs: 0, syncEveryMs: 0 });
      expect(vi.getTimerCount()).toBe(0);
      h.stop();
    });

    it("logs to stderr unless quiet, including non-Error failures", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const h = startScheduler(
        async () => {
          throw "disk full";
        },
        { dreamEveryMs: 60_000, syncEveryMs: 30_000 }
      );
      expect(err).toHaveBeenCalledWith("[ynm-mcp scheduler] dream every 60000ms");
      expect(err).toHaveBeenCalledWith("[ynm-mcp scheduler] sync every 30000ms");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.stats.lastError).toBe("sync: disk full");
      // Both timers fire at 60 s; lastError is one field, so the later sync failure wins there
      // while the dream failure still reaches the log.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.stats.lastError).toBe("sync: disk full");
      expect(err).toHaveBeenCalledWith("[ynm-mcp scheduler] dream: disk full");
      h.stop();
    });
  });

  it("logs a successful dream run when not quiet", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ynm = make();
    const h = startScheduler(async () => ynm, { now: () => new Date(clock) });
    await h.dreamNow();
    expect(h.stats.dreamRuns).toBe(1);
    expect(h.stats.lastError).toBeNull();
    expect(
      err.mock.calls.some(([m]) => /^\[ynm-mcp scheduler\] dream #1: \{/.test(String(m)))
    ).toBe(true);
    err.mockRestore();
    h.stop();
  });
});
