import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HOOK_EVENTS,
  type HookEvent,
  type HookInput,
  type HookOutput,
  parseHookInput,
  promptHook,
} from "@ynm/service/hook-intent";

/** Stop fires every turn; the expire pass runs at most this often per session. */
export const STOP_INTERVAL_MS = 5 * 60_000;
const STAMP_MAX_AGE_MS = 24 * 3600_000;

/** Reads all of stdin; a terminal or a stdin that never closes yields what arrived so far. */
function readStdin(limitMs = 5000): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let buf = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(buf);
    };
    const timer = setTimeout(done, limitMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d: string) => {
      buf += d;
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

/**
 * True when this session's expire pass ran within STOP_INTERVAL_MS, so this Stop can answer
 * without opening the store. Otherwise stamps the session and prunes day-old stamps.
 */
export function stopThrottled(sessionId: string, now = Date.now()): boolean {
  const dir = join(process.env.YNM_HOME ?? join(homedir(), ".ynm"), "hooks");
  const stamp = join(dir, `stop-${sessionId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100)}`);
  try {
    if (now - statSync(stamp).mtimeMs < STOP_INTERVAL_MS) return true;
  } catch {
    // no stamp yet
  }
  try {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (now - statSync(p).mtimeMs > STAMP_MAX_AGE_MS) rmSync(p, { force: true });
    }
    writeFileSync(stamp, "");
  } catch {
    // a stamp is an optimisation; failing to write one only costs speed
  }
  return false;
}

/**
 * Starts `ynm sync --quiet` detached in `cwd`, so the turn never waits on it. A single-executable
 * build re-runs itself; otherwise Node re-runs the script it was started from (bin/run.js, or the
 * bundle's ynm.mjs).
 */
export function launchSync(cwd: string): void {
  let sea = false;
  try {
    sea = (createRequire(import.meta.url)("node:sea") as { isSea(): boolean }).isSea();
  } catch {
    // an older Node without node:sea is never a single executable
  }
  const args = sea ? ["sync", "--quiet"] : [process.argv[1] as string, "sync", "--quiet"];
  spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, YNM_NO_CLAUDE_CLI: "1" },
  })
    .on("error", () => {})
    .unref();
}

async function answer(event: string, input: HookInput, cwdFlag?: string): Promise<HookOutput> {
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
    process.stderr.write(`ynm hook: unknown event "${event}" (have: ${HOOK_EVENTS.join(", ")})\n`);
    return {};
  }
  const e = event as HookEvent;
  if (e === "prompt") return promptHook(input);
  if (e === "stop" && (!input.session_id || stopThrottled(input.session_id))) return {};
  const cwd = cwdFlag ?? (typeof input.cwd === "string" && input.cwd ? input.cwd : undefined);
  // Loaded only when the store is needed, so the prompt hook and a throttled stop start fast.
  const { autoSyncOnStop, openYnm, sessionStartHook, stopHook } = await import("@ynm/service");
  // Hooks run on the client's clock: skip the Claude CLI probe, which only picks a dream writer.
  const { ynm, loaded, worktree } = await openYnm({
    cwd,
    env: { ...process.env, YNM_NO_CLAUDE_CLI: "1" },
  });
  if (e === "session-start") return sessionStartHook(ynm, input);
  const out = await stopHook(ynm, input);
  if (worktree.isGitRepo)
    await autoSyncOnStop(ynm, {
      sync: loaded.config.sync,
      env: process.env,
      home: loaded.home,
      repo: worktree.mainRepoPath,
      launch: () => launchSync(worktree.currentPath),
    });
  return out;
}

/**
 * Answers one client hook (ADR-016). Never fails the session: any error becomes `{}` on stdout,
 * with the message on stderr, and stdout carries nothing but the one JSON line.
 */
export async function runHook(event: string | undefined, cwdFlag?: string): Promise<void> {
  let out: HookOutput = {};
  try {
    const input = parseHookInput(await readStdin());
    if (event) out = await answer(event, input, cwdFlag);
    else process.stderr.write(`ynm hook: missing event (have: ${HOOK_EVENTS.join(", ")})\n`);
  } catch (err) {
    process.stderr.write(`ynm hook: ${(err as Error).message}\n`);
    out = {};
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

/**
 * The launcher's fast path for `ynm hook ...`: parses `<event> [--cwd <dir>]` by hand so a hook
 * skips oclif's startup. Returns false (oclif handles it) for help or anything unexpected.
 */
export async function runHookFast(argv: string[]): Promise<boolean> {
  if (argv[0] !== "hook") return false;
  const rest = argv.slice(1);
  let event: string | undefined;
  let cwd: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--cwd" && i + 1 < rest.length) cwd = rest[++i];
    else if (a.startsWith("--cwd=")) cwd = a.slice("--cwd=".length);
    else if (a.startsWith("-") || event) return false;
    else event = a;
  }
  await runHook(event, cwd);
  return true;
}
