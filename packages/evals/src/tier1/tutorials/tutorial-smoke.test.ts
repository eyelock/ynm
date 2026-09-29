import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Layer 2 of the tutorial evals (docs/tutorial/RUNNING.md): every bash block of every tutorial
 * runs in order in a sandbox and must exit zero. No output matching; that is layer 1's job.
 */
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");
const tutorials = join(repoRoot, "docs", "tutorial");
const cli = join(repoRoot, "packages", "cli", "bin", "run.js");

export interface TutorialBlock {
  heading: string;
  code: string;
  /** From an HTML comment on the line before the fence: `<!-- tutorial: skip unless X -->`. */
  skipUnlessEnv?: string;
}

/** Extracts the bash blocks of a tutorial with the nearest heading and any skip marker. */
export function tutorialBlocks(markdown: string): TutorialBlock[] {
  const out: TutorialBlock[] = [];
  let heading = "";
  let pending: string | undefined;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const h = /^#{1,3}\s+(.*)$/.exec(line);
    if (h) heading = h[1] as string;
    const skip = /^<!--\s*tutorial:\s*skip unless\s+([A-Z0-9_]+)\s*-->$/.exec(line.trim());
    if (skip) {
      pending = skip[1];
      continue;
    }
    if (line.trim() === "```bash") {
      const code: string[] = [];
      for (i += 1; i < lines.length && (lines[i] as string).trim() !== "```"; i++)
        code.push(lines[i] as string);
      out.push({ heading, code: code.join("\n"), skipUnlessEnv: pending });
      pending = undefined;
    } else if (line.trim() !== "") pending = undefined;
  }
  return out;
}

export function tutorialFiles(): string[] {
  return readdirSync(tutorials)
    .filter((f) => /^\d{2}-.*\.md$/.test(f))
    .sort();
}

/** A PATH entry with `ynm` pointing at this checkout, as the tutorial index tells humans to make. */
export function sandboxBin(): string {
  const bin = mkdtempSync(join(tmpdir(), "ynm-tutorial-bin-"));
  writeFileSync(join(bin, "ynm"), `#!/bin/sh\nexec node ${cli} "$@"\n`);
  chmodSync(join(bin, "ynm"), 0o755);
  return bin;
}

describe("tutorial smoke (every command block exits zero)", () => {
  for (const file of tutorialFiles()) {
    it(file, () => {
      const blocks = tutorialBlocks(readFileSync(join(tutorials, file), "utf8"));
      expect(blocks.length).toBeGreaterThan(0);
      const script = ["set -e"];
      for (const [i, b] of blocks.entries()) {
        if (b.skipUnlessEnv && !process.env[b.skipUnlessEnv]) {
          script.push(`echo "### step ${i + 1} skipped (${b.heading}; needs ${b.skipUnlessEnv})"`);
          continue;
        }
        script.push(`echo "### step ${i + 1}: ${b.heading.replace(/"/g, "")}"`, b.code);
      }
      const r = spawnSync("sh", ["-c", script.join("\n")], {
        cwd: tmpdir(),
        encoding: "utf8",
        timeout: 600_000,
        env: {
          ...process.env,
          PATH: `${sandboxBin()}:${process.env.PATH ?? ""}`,
          YNM_NO_CLAUDE_CLI: "1",
        },
      });
      const lastStep = (r.stdout.match(/### step \d+[^\n]*/g) ?? []).pop();
      expect(r.status, `${file} failed at ${lastStep ?? "start"}\n${r.stderr.slice(-2000)}`).toBe(
        0
      );
    }, 600_000);
  }
});
