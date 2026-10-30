import { mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryLog } from "@ynm/store";
import { DEFAULT_REDACTION } from "../config.js";
import { IndexManager } from "../indexing.js";
import { Ynm } from "../ynm.js";
import { type AutoSyncOptions, autoSyncOnStop, autoSyncStamp, shouldAutoSync } from "./autosync.js";

function logWith(id: string, level: "personal" | "distributed", unpushed: () => boolean) {
  return Object.assign(new MemoryLog(id, level), { unpushed: async () => unpushed() });
}

function setup(over: { distributed?: boolean; personal?: boolean } = {}) {
  const state = { distributed: over.distributed ?? true, personal: over.personal ?? false };
  const ynm = new Ynm({
    mounts: [
      {
        id: "personal",
        level: "personal",
        location: "mem",
        log: logWith("p", "personal", () => state.personal),
      },
      {
        id: "shared",
        level: "distributed",
        location: "mem",
        log: logWith("d", "distributed", () => state.distributed),
      },
    ],
    actor: "t",
    userId: "u",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
  });
  const home = mkdtempSync(join(tmpdir(), "ynm-autosync-"));
  const launched: number[] = [];
  const opts = (o: Partial<AutoSyncOptions> = {}): AutoSyncOptions => ({
    sync: { auto: true, intervalMinutes: 5 },
    env: {},
    home,
    repo: "/work/project",
    launch: () => launched.push(1),
    ...o,
  });
  return { ynm, state, home, launched, opts };
}

describe("auto-sync from the Stop hook (ADR-016)", () => {
  it("is off by default", async () => {
    const t = setup();
    expect(await shouldAutoSync(t.ynm, t.opts({ sync: { auto: false, intervalMinutes: 5 } }))).toBe(
      false
    );
    expect(await autoSyncOnStop(t.ynm, t.opts({ sync: { auto: false, intervalMinutes: 5 } }))).toBe(
      false
    );
    expect(t.launched).toEqual([]);
  });

  it("launches once when on, unpushed and no stamp, and stamps the repository", async () => {
    const t = setup();
    expect(await autoSyncOnStop(t.ynm, t.opts())).toBe(true);
    expect(t.launched).toHaveLength(1);
    expect(statSync(autoSyncStamp(t.home, "/work/project")).isFile()).toBe(true);
    // a concurrent Stop inside the interval does not launch a second one
    expect(await autoSyncOnStop(t.ynm, t.opts())).toBe(false);
    expect(t.launched).toHaveLength(1);
  });

  it("goes out at the first Stop after the interval when it was skipped inside it", async () => {
    const t = setup();
    await autoSyncOnStop(t.ynm, t.opts());
    const stamp = autoSyncStamp(t.home, "/work/project");
    const now = Date.now();
    utimesSync(stamp, new Date(now - 4 * 60_000), new Date(now - 4 * 60_000));
    expect(await shouldAutoSync(t.ynm, t.opts({ now }))).toBe(false);
    expect(await shouldAutoSync(t.ynm, t.opts({ now: now + 2 * 60_000 }))).toBe(true);
    expect(await shouldAutoSync(t.ynm, t.opts({ sync: { auto: true, intervalMinutes: 30 } }))).toBe(
      false
    );
  });

  it("keeps a stamp per repository", async () => {
    const t = setup();
    await autoSyncOnStop(t.ynm, t.opts());
    expect(await shouldAutoSync(t.ynm, t.opts({ repo: "/work/other" }))).toBe(true);
  });

  it("does nothing when nothing is unpushed", async () => {
    const t = setup({ distributed: false });
    expect(await autoSyncOnStop(t.ynm, t.opts())).toBe(false);
    expect(t.launched).toEqual([]);
  });

  it("does nothing inside a sync", async () => {
    const t = setup();
    expect(await shouldAutoSync(t.ynm, t.opts({ env: { YNM_SYNC_IN_PROGRESS: "1" } }))).toBe(false);
  });

  it("ignores unpushed personal writes", async () => {
    const t = setup({ distributed: false, personal: true });
    expect(await shouldAutoSync(t.ynm, t.opts())).toBe(false);
  });

  it("never throws, even when the launch fails", async () => {
    const t = setup();
    const launch = () => {
      throw new Error("spawn failed");
    };
    expect(await autoSyncOnStop(t.ynm, t.opts({ launch }))).toBe(false);
  });
});
