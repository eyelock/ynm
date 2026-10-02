/**
 * Milestone gate: M5 Hosted. See .claude/plans/milestones.md (untracked) and docs/adr/014.
 * A milestone closes when this file is green with zero todos.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dockerAvailable } from "../tier1/hosted/docker.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const evals = join(repoRoot, "packages", "evals");

function vitest(cwd: string, ...args: string[]) {
  const r = spawnSync("pnpm", ["exec", "vitest", "run", "--reporter=verbose", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe("gate M5: hosted", () => {
  it("ADR-009: Docker HTTP integration: auth, two clients, dream worker, local clone sync", () => {
    expect(dockerAvailable(), "Docker daemon must be running for this gate").toBe(true);
    const r = vitest(evals, "src/tier1/hosted/docker.integration.test.ts");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/✓.*auth, two clients, dream worker, local clone sync/);
  }, 900_000);

  it("ADR-004: conformance suite passes on sqlite; hosted suite runs unchanged on git-notes and sqlite", () => {
    const store = vitest(join(repoRoot, "packages", "store"), "src/providers/sqlite.test.ts");
    expect(store.status, store.out).toBe(0);
    expect(store.out).toMatch(/conformance: sqlite/);
    const mcp = vitest(join(repoRoot, "packages", "mcp"), "src/transport/http.test.ts");
    expect(mcp.status, mcp.out).toBe(0);
    expect(mcp.out).toMatch(/transport on git-notes/);
    expect(mcp.out).toMatch(/transport on sqlite/);
    expect(mcp.out).toMatch(/RFC 6750 challenge/);
  }, 300_000);

  it("ADR-013: golden tests for copilot-cli, opencode and pi adapters; Pi extension tool tests", () => {
    const r = vitest(join(repoRoot, "packages", "service"), "src/clients");
    expect(r.status, r.out).toBe(0);
    for (const name of ["copilot-cli adapter", "opencode adapter", "pi adapter"])
      expect(r.out).toContain(name);
    expect(r.out).toMatch(/extension's tools run the ynm CLI/);
    expect(existsSync(join(repoRoot, "integrations", "pi", "ynm.ts"))).toBe(true);
  }, 300_000);

  it("NFR-6: hosted suite passes against a bare repo on a Gitea container", () => {
    expect(dockerAvailable(), "Docker daemon must be running for this gate").toBe(true);
    const r = vitest(evals, "src/tier1/hosted/gitea.integration.test.ts");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/✓.*two clones sync distributed memory through the forge/);
  }, 900_000);

  it("Exit: docker compose demo with one hosted store, one HTTP agent client, one syncing clone", () => {
    expect(dockerAvailable(), "Docker daemon must be running for this gate").toBe(true);
    const r = spawnSync("sh", [join(repoRoot, "infra", "docker", "demo.sh"), "ynm-gate"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 900_000,
    });
    const out = r.stdout + r.stderr;
    expect(r.status, out).toBe(0);
    expect(out).toMatch(/remembered 01/);
    expect(out).toMatch(/release gate/);
    expect(out).toMatch(/pushed one memory back/);
  }, 900_000);
});
