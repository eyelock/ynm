import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/run.js", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "ynm-cli-home-"));

/** The isolated personal store every CLI test in this process shares. */
export const testYnmHome = join(home, ".ynm");

/** Runs the built CLI as a user would, with an isolated personal store. */
export function ynm(
  cwd: string,
  ...args: string[]
): { stdout: string; stderr: string; status: number | null } {
  return ynmWithInput(cwd, undefined, ...args);
}

/** As `ynm`, with `input` piped to stdin (stdin closed and empty when undefined). */
export function ynmWithInput(
  cwd: string,
  input: string | undefined,
  ...args: string[]
): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("node", [bin, ...args], {
    cwd,
    encoding: "utf8",
    input: input ?? "",
    env: {
      ...process.env,
      YNM_HOME: testYnmHome,
      YNM_USER: "tester",
      YNM_NO_CLAUDE_CLI: "1",
    },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}
