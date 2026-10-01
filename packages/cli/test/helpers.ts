import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The launcher every CLI test runs, exactly as a user's `ynm` would. */
export const bin = fileURLToPath(new URL("../bin/run.js", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "ynm-cli-home-"));

/** The isolated personal store every CLI test in this process shares. */
export const testYnmHome = join(home, ".ynm");

type Result = { stdout: string; stderr: string; status: number | null };

/**
 * The environment a CLI test runs with: an isolated personal store, no Claude CLI probe, and no
 * model keys or endpoints, so a test can never reach a paid model whatever the shell exports.
 */
export function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    YNM_HOME: testYnmHome,
    YNM_USER: "tester",
    YNM_NO_CLAUDE_CLI: "1",
  };
  for (const key of ["TYPESAFE_API_KEY", "OPENAI_API_KEY", "YNM_OPENAI_BASE_URL"]) delete env[key];
  return { ...env, ...overrides };
}

/** Runs the built CLI as a user would, with an isolated personal store. */
export function ynm(cwd: string, ...args: string[]): Result {
  return ynmWithInput(cwd, undefined, ...args);
}

/** As `ynm`, with `input` piped to stdin (stdin closed and empty when undefined). */
export function ynmWithInput(cwd: string, input: string | undefined, ...args: string[]): Result {
  return ynmWith(cwd, { input }, ...args);
}

/** As `ynm`, with stdin and environment overrides (e.g. HOME or PATH) for this one run. */
export function ynmWith(
  cwd: string,
  opts: { input?: string; env?: NodeJS.ProcessEnv },
  ...args: string[]
): Result {
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    input: opts.input ?? "",
    env: testEnv(opts.env),
    timeout: 60_000,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** oclif wraps error output at the terminal width; joins the lines so a phrase can be matched. */
export function unwrapped(stderr: string): string {
  return stderr.replace(/\s*\n\s*›?\s*/g, " ");
}
