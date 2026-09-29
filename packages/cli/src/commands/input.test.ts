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
