import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ynm } from "../../test/helpers.js";

describe("input validation exit codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ynm-input-"));

  it("malformed JSON in --data exits 2 with invalid input", () => {
    const r = ynm(dir, "remember", "--type", "semantic", "--content", "x", "--data", "{bad");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/invalid input: --data: not valid JSON/);
  });

  it("a bare date for --since is accepted", () => {
    const r = ynm(dir, "recall", "--text", "x", "--since", "2026-09-01", "--json");
    expect(r.status, r.stderr).toBe(0);
  });

  it("a bad --since exits 2 and names the expected format", () => {
    const r = ynm(dir, "recall", "--text", "x", "--since", "soon");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("since: expected an ISO 8601 date-time");
  });

  it("--tags a,b makes two tags", () => {
    let r = ynm(
      dir,
      "remember",
      "--type",
      "semantic",
      "--content",
      "tagged twice",
      "--tags",
      "a,b"
    );
    expect(r.status, r.stderr).toBe(0);
    r = ynm(dir, "list", "--json");
    const rows = JSON.parse(r.stdout) as Array<{ tags: string[]; current: { content: string } }>;
    expect(rows.find((m) => m.current.content === "tagged twice")?.tags).toEqual(["a", "b"]);
  });
});

describe("ynm validate", () => {
  it("prints each check for a harness and exits 1 when a piece is missing", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ynm-validate-"));
    mkdirSync(join(dir, ".ynh-plugin"));
    writeFileSync(
      join(dir, ".ynh-plugin", "plugin.json"),
      JSON.stringify({ name: "h", version: "0.1.0" })
    );
    const before = ynm(dir, "validate", dir);
    expect(before.status).toBe(1);
    expect(before.stdout).toMatch(/FAIL\s+server\s+missing/);
    expect(ynm(dir, "client", "install").status).toBe(0);
    const after = ynm(dir, "validate", dir);
    expect(after.stdout).toMatch(/ok\s+server\s+mcp_servers\.ynm runs `ynm serve`/);
    expect(after.stdout).toMatch(
      /ok\s+guidance\s+includes https:\/\/github\.com\/eyelock\/ynm path integrations pick skills\/ynm-memory/
    );
    expect(after.stdout).toMatch(/ok\s+hooks\s+on_session_start runs `ynm hook session-start`/);
  });
});
