import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "./lock.js";

describe("withLock", () => {
  const dir = mkdtempSync(join(tmpdir(), "ynm-lock-"));

  it("serialises overlapping holders in one process", async () => {
    const lock = join(dir, "a.lock");
    const order: string[] = [];
    await Promise.all([
      withLock(lock, async () => {
        order.push("a-in");
        await new Promise((r) => setTimeout(r, 30));
        order.push("a-out");
      }),
      withLock(lock, async () => {
        order.push("b-in");
        order.push("b-out");
      }),
    ]);
    expect(order.indexOf("a-out")).toBeLessThan(order.indexOf("b-in"));
  });

  it("breaks a stale lock held by a dead pid", async () => {
    const lock = join(dir, "stale.lock");
    writeFileSync(lock, "999999999\n1\n");
    await expect(withLock(lock, async () => "ok")).resolves.toBe("ok");
  });

  it("times out on a live lock", async () => {
    const lock = join(dir, "live.lock");
    writeFileSync(lock, `${process.pid}\n${Date.now()}\n`);
    await expect(withLock(lock, async () => "no", 50)).rejects.toThrow(/lock timeout/);
  });
});
