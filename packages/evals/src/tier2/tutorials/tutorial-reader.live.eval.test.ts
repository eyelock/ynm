import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractJson } from "@ynm/models";
import { z } from "zod";
import { recordMetric } from "../../baseline.js";
import { sandboxBin, tutorialBlocks, tutorialFiles } from "../../tier1/tutorials/support.js";

/**
 * Layer 1 of the tutorial evals (docs/tutorial/RUNNING.md): a model reads each tutorial, runs
 * every step in the sandbox, compares what it sees with the Expected blocks, and reports per
 * step. Opt-in (YNM_EVAL_CLAUDE_CLI=1) because it spends tokens; skipped without `claude`.
 */
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");
const tutorials = join(repoRoot, "docs", "tutorial");
const MODEL = process.env.YNM_EVAL_MODEL ?? "claude-sonnet-4-5";
const enabled =
  process.env.YNM_EVAL_CLAUDE_CLI === "1" &&
  spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;

const Report = z.object({
  steps: z.array(
    z.object({
      heading: z.string(),
      ran: z.boolean(),
      matched: z.enum(["yes", "no", "skipped"]),
      observed: z.string().optional(),
      note: z.string().optional(),
    })
  ),
});

function prompt(file: string, skippable: string[]): string {
  return [
    `Read ${file}. It is a tutorial whose steps are bash code blocks, each followed by an "Expected" block.`,
    "Run every bash block in order, in this shell, exactly as written. Do not fix, skip or reorder anything.",
    "Exceptions: a step may be skipped only if the tutorial marks it and its condition is not met. Steps marked skippable:",
    skippable.length ? skippable.map((s) => `- ${s}`).join("\n") : "- none",
    "After each block compare what you see with the Expected block. Literal text must appear as shown; described parts (an id, a date, a version) may differ. Exit codes matter: a command the tutorial does not say fails must exit 0.",
    "Do not edit any file. Do not create memories other than those the tutorial creates.",
    'When done, reply with only a JSON object: {"steps":[{"heading":"...","ran":true,"matched":"yes"|"no"|"skipped","observed":"<output, for mismatches>","note":"<why, for mismatches or skips>"}]}, one entry per bash block, in order.',
  ].join("\n");
}

describe.skipIf(!enabled)("tier2 tutorial reader (live)", () => {
  for (const name of tutorialFiles()) {
    it(name, () => {
      const file = join(tutorials, name);
      const blocks = tutorialBlocks(readFileSync(file, "utf8"));
      const skippable = blocks
        .filter((b) => b.skipUnlessEnv && !process.env[b.skipUnlessEnv])
        .map((b) => `${b.heading} (needs ${b.skipUnlessEnv})`);
      const r = spawnSync(
        "claude",
        [
          "-p",
          prompt(file, skippable),
          "--model",
          MODEL,
          "--allowedTools",
          "Bash,Read",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--output-format",
          "json",
          "--max-turns",
          String(blocks.length * 4 + 10),
        ],
        {
          cwd: tmpdir(),
          encoding: "utf8",
          timeout: 900_000,
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...process.env,
            PATH: `${sandboxBin()}:${process.env.PATH ?? ""}`,
            YNM_NO_CLAUDE_CLI: "1",
            YNM_HOME: "/tmp/ynm-tutorial/home",
            YNM_USER: "tutorial",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          },
        }
      );
      expect(r.status, r.stderr.slice(-1000)).toBe(0);
      const result = String((JSON.parse(r.stdout) as { result?: string }).result ?? "");
      const report = Report.parse(extractJson(result));
      const ran = report.steps.filter((s) => s.matched !== "skipped");
      const matched = ran.filter((s) => s.matched === "yes").length;
      const failures = ran.filter((s) => s.matched === "no");
      console.info(
        `${name}: ${matched}/${ran.length} steps matched, ${report.steps.length - ran.length} skipped (${MODEL})` +
          failures
            .map(
              (f) =>
                `\n  MISMATCH ${f.heading}: ${(f.note ?? "").slice(0, 200)}\n    observed: ${(f.observed ?? "").slice(0, 300).replace(/\n/g, " | ")}`
            )
            .join("")
      );
      expect(report.steps.length, "one entry per bash block").toBe(blocks.length);
      recordMetric({
        name: `tutorial:${name.replace(/\.md$/, "")}`,
        size: ran.length,
        value: ran.length ? matched / ran.length : 1,
      });
      expect(failures, failures.map((f) => f.heading).join(", ")).toEqual([]);
    }, 900_000);
  }
});
