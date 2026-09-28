import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../../bin/run.js", import.meta.url));

/** Runs the built CLI as a user would; turbo builds before test so dist exists. */
function ynm(...args: string[]): { stdout: string; status: number | null } {
  const r = spawnSync("node", [bin, ...args], { encoding: "utf8" });
  return { stdout: r.stdout, status: r.status };
}

describe("ynm status", () => {
  it("reports name and version as JSON", () => {
    const { stdout, status } = ynm("status", "--json");
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { name: string; version: string; milestone: string };
    expect(parsed.name).toBe("ynm");
    expect(parsed.version).toBe("0.1.0");
    expect(parsed.milestone).toBe("M0");
  });

  it("prints a one-line human summary", () => {
    const { stdout, status } = ynm("status");
    expect(status).toBe(0);
    expect(stdout).toMatch(/^ynm 0\.1\.0/);
  });
});
