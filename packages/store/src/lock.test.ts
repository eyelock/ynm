import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
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

  it("does not break a lock whose live holder is older than the stale age (ynm #166)", async () => {
    const lock = join(dir, "old-live.lock");
    const old = Date.now() - 10 * 60_000;
    writeFileSync(lock, `${process.pid}\n${old}\ntoken\n${hostname()}\n`);
    await expect(withLock(lock, async () => "no", 80)).rejects.toThrow(/lock timeout/);
    expect(readFileSync(lock, "utf8")).toContain("token");
    unlinkSync(lock);
  });

  it("breaks an old lock held on another host", async () => {
    const lock = join(dir, "foreign.lock");
    const old = Date.now() - 10 * 60_000;
    writeFileSync(lock, `${process.pid}\n${old}\ntoken\nsome-other-host\n`);
    await expect(withLock(lock, async () => "ok")).resolves.toBe("ok");
  });

  it("does not break a recent lock held on another host", async () => {
    const lock = join(dir, "foreign-new.lock");
    writeFileSync(lock, `1\n${Date.now()}\ntoken\nsome-other-host\n`);
    await expect(withLock(lock, async () => "no", 50)).rejects.toThrow(/lock timeout/);
    unlinkSync(lock);
  });

  it("does not unlink a lock that replaced its own", async () => {
    const lock = join(dir, "replaced.lock");
    const replacement = `${process.pid}\n${Date.now()}\nother-token\n${hostname()}\n`;
    await withLock(lock, async () => {
      unlinkSync(lock);
      writeFileSync(lock, replacement);
    });
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(replacement);
    unlinkSync(lock);
  });
});
