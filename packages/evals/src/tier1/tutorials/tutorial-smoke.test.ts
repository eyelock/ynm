import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxBin, tutorialBlocks, tutorialFiles, tutorials } from "./support.js";

/**
 * Layer 2 of the tutorial evals (docs/tutorial/RUNNING.md): every bash block of every tutorial
 * runs in order in a sandbox and must exit zero. No output matching; that is layer 1's job.
 */
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
          YNM_HOME: "/tmp/ynm-tutorial/home",
          YNM_USER: "tutorial",
        },
      });
      const lastStep = (r.stdout.match(/### step \d+[^\n]*/g) ?? []).pop();
      expect(r.status, `${file} failed at ${lastStep ?? "start"}\n${r.stderr.slice(-2000)}`).toBe(
        0
      );
    }, 600_000);
  }
});
