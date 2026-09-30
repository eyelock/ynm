import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/**
 * The generated docs (scripts/gen-docs.mjs, `make docs-gen`) are checked in. Regenerating them
 * into a temporary directory must reproduce the checked-in files exactly, the same guard
 * `pnpm gen:clients` has. Links in docs/ must resolve, and every YNM_* variable the code reads
 * must be documented in the configuration reference.
 */
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");
const script = join(repoRoot, "scripts", "gen-docs.mjs");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("tier1 generated docs", () => {
  it("regeneration reproduces the checked-in docs (run `make docs-gen` after a change)", () => {
    const out = mkdtempSync(join(tmpdir(), "ynm-docs-"));
    const r = spawnSync("node", [script, "--out", out], { cwd: repoRoot, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const generated = files(out);
    expect(generated.length).toBeGreaterThan(0);
    for (const file of generated) {
      const rel = relative(out, file);
      expect(readFileSync(file, "utf8"), `docs/${rel} is stale; run make docs-gen`).toBe(
        readFileSync(join(repoRoot, "docs", rel), "utf8")
      );
    }
  });

  it("every relative link and anchor in docs/ resolves", () => {
    const r = spawnSync("node", [script, "--check-links"], { cwd: repoRoot, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("every YNM_* environment variable is in the configuration reference", () => {
    const sources = [
      ...readdirSync(join(repoRoot, "packages")).flatMap((pkg) =>
        ["src", "scripts", "bin"].flatMap((sub) => {
          const dir = join(repoRoot, "packages", pkg, sub);
          try {
            return files(dir);
          } catch {
            return [];
          }
        })
      ),
      ...files(join(repoRoot, "infra")),
      join(repoRoot, "Dockerfile"),
      join(repoRoot, ".github", "workflows", "ci.yml"),
    ].filter((f) => /\.(ts|mjs|js|sh|yml)$|Dockerfile$/.test(f));
    const vars = new Set<string>();
    for (const f of sources)
      for (const m of readFileSync(f, "utf8").matchAll(/\bYNM_[A-Z][A-Z0-9_]*[A-Z0-9]\b/g))
        vars.add(m[0]);
    const doc = readFileSync(join(repoRoot, "docs", "reference", "configuration.md"), "utf8");
    const missing = [...vars].filter((v) => !doc.includes(`\`${v}\``)).sort();
    expect(missing).toEqual([]);
  });
});
