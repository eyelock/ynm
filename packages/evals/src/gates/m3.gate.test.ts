/**
 * Milestone gate: M3 MCP local, the MVP. See .claude/plans/milestones.md (untracked) and
 * docs/adr/014. A milestone closes when this file is green with zero todos.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readBaseline } from "../baseline.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const evals = join(repoRoot, "packages", "evals");

function vitest(cwd: string, ...args: string[]) {
  const r = spawnSync("pnpm", ["exec", "vitest", "run", "--reporter=verbose", ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe("gate M3: MCP local (MVP)", () => {
  it("ADR-008: every MCP tool has a CLI command with the same schema (parity)", () => {
    const r = vitest(evals, "src/tier1/parity");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/memory_status/);
  }, 300_000);

  it("ADR-008: every tool exercised over JSON-RPC through an in-memory client, not by calling handlers", () => {
    const r = vitest(join(repoRoot, "packages", "mcp"), "src/server.test.ts");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/exercises every tool through the protocol/);
  }, 300_000);

  it("ADR-009: stdio and HTTP transports serve a bare repo with no working tree", () => {
    const r = vitest(join(repoRoot, "packages", "mcp"));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/serves a bare repo with no work tree/);
    expect(r.out).toMatch(/serves health, rejects a missing bearer/);
  }, 300_000);

  it("NFR-11: two interleaved HTTP clients share no state", () => {
    const r = vitest(join(repoRoot, "packages", "mcp"), "src/transport/http.test.ts");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/two interleaved clients/);
  }, 300_000);

  it("ADR-013: golden tests for claude-code and ynh adapters; ynh validate passes on the checked-in plugin", () => {
    const r = vitest(join(repoRoot, "packages", "service"), "src/clients");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/ynh plugin generation matches the checked-in manifest/);
    const ynd = spawnSync("ynd", ["validate", repoRoot], { encoding: "utf8" });
    if (ynd.error) console.warn("ynd not installed; manifest validation skipped on this machine");
    else expect(`${ynd.stdout}${ynd.stderr}`, ynd.stdout + ynd.stderr).toMatch(/valid/);
  }, 300_000);

  it("FR-14: guidance efficacy live eval baseline recorded (agent remembers and recalls at the right moments)", () => {
    const b = readBaseline() as Record<string, { value?: number }>;
    const key = Object.keys(b).find((k) => k.startsWith("guidance:"));
    expect(
      key,
      "run the tier2 guidance eval with YNM_WRITE_BASELINE=1 (needs the claude CLI)"
    ).toBeDefined();
    expect(b[key as string]?.value).toBeGreaterThanOrEqual(2 / 3);
  });

  it("MVP: end-to-end demo script (init, install, two sessions, recall) passes", () => {
    const r = vitest(evals, "src/tier1/e2e");
    expect(r.status, r.out).toBe(0);
  }, 300_000);
});
