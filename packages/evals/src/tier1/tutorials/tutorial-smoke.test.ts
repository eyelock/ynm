import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  privateSandbox,
  sandboxEnv,
  tutorialBlocks,
  tutorialFiles,
  tutorials,
  withSandbox,
} from "./support.js";

/**
 * Layer 2 of the tutorial evals (docs/tutorial/RUNNING.md): every bash block of every tutorial
 * runs in order in a sandbox and must exit zero. No output matching; that is layer 1's job.
 */
describe("tutorial smoke (every command block exits zero)", () => {
  for (const file of tutorialFiles()) {
    it(file, () => {
      const root = privateSandbox();
      const blocks = tutorialBlocks(withSandbox(readFileSync(join(tutorials, file), "utf8"), root));
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
        env: sandboxEnv(root),
      });
      const lastStep = (r.stdout.match(/### step \d+[^\n]*/g) ?? []).pop();
      expect(r.status, `${file} failed at ${lastStep ?? "start"}\n${r.stderr.slice(-2000)}`).toBe(
        0
      );
    }, 600_000);
  }
});
