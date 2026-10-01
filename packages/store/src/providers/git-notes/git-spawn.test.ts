import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/** A stand-in child process so the wrapper's kill, signal and stdin paths can be driven. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed: string[] = [];
  kill(signal: string): boolean {
    this.killed.push(signal);
    return true;
  }
}

let next: FakeChild;
vi.mock("node:child_process", () => ({
  spawn: () => {
    next = new FakeChild();
    return next;
  },
}));

const { GitError, git } = await import("./git.js");

afterEach(() => {
  vi.useRealTimers();
});

describe("git process supervision", () => {
  it("kills git after the timeout and reports the signal", async () => {
    vi.useFakeTimers();
    const p = git(["fetch"], { cwd: "." });
    const child = next;
    vi.advanceTimersByTime(30_000);
    expect(child.killed).toEqual(["SIGKILL"]);
    child.emit("close", null, "SIGKILL");
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err.code).toBe("SIGKILL");
  });

  it("does not kill git that finishes before the timeout", async () => {
    vi.useFakeTimers();
    const p = git(["status"], { cwd: "." });
    const child = next;
    child.stdout.emit("data", Buffer.from("ok"));
    child.emit("close", 0, null);
    await expect(p).resolves.toBe("ok");
    vi.advanceTimersByTime(60_000);
    expect(child.killed).toEqual([]);
  });

  it("kills git whose output exceeds the buffer cap", async () => {
    const p = git(["cat-file", "--batch"], { cwd: "." });
    const child = next;
    const chunk = Buffer.allocUnsafe(128 * 1024 * 1024);
    child.stdout.emit("data", chunk);
    expect(child.killed).toEqual([]);
    child.stdout.emit("data", chunk);
    child.stdout.emit("data", Buffer.from("x"));
    expect(child.killed).toEqual(["SIGKILL"]);
    child.emit("close", null, "SIGKILL");
    await expect(p).rejects.toThrow(/failed \(SIGKILL\)/);
  });

  it("ignores a stdin error and reports the real exit", async () => {
    const p = git(["mktree"], { cwd: ".", input: "data" });
    const child = next;
    child.stdin.emit("error", new Error("EPIPE"));
    child.stderr.emit("data", Buffer.from("fatal: bad input"));
    child.emit("close", 128, null);
    await expect(p).rejects.toThrow("git mktree failed (128): fatal: bad input");
  });
});
