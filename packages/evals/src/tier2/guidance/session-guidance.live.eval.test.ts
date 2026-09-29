/**
 * Tier 2 live guidance eval (ADR-014, FR-14): does an agent given the ynm guidance and tools
 * remember and recall at the right moments? Drives Claude Code headless against a real repo
 * with the real MCP server. Skipped when the `claude` CLI is not available.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "@ynm/store/testing/git";
import { recordMetric } from "../../baseline.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");
const cli = join(repoRoot, "packages", "cli", "bin", "run.js");
const mcpBin = join(repoRoot, "packages", "mcp", "bin", "run.js");
const MODEL = process.env.YNM_EVAL_MODEL ?? "claude-sonnet-4-5";
const hasClaude = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;

interface Scenario {
  name: string;
  seed?: string;
  prompt: string;
  expect: (
    answer: string,
    memoriesAfter: Array<{ content: string }>,
    memoriesBefore: number
  ) => boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: "remember an explicit instruction",
    prompt:
      "Please remember for future sessions: our release process requires running `pnpm gate M3` before tagging a release. Store it as a procedural memory, then reply with the single word DONE.",
    expect: (_a, after, before) =>
      after.length > before && after.some((m) => /gate M3/.test(m.content)),
  },
  {
    name: "recall a seeded fact",
    seed: "The staging deploy target is the eu-west-2 cluster named blue-heron.",
    prompt:
      "Using your memory tools, what is the name of the staging deploy target cluster? Reply with just the cluster name.",
    expect: (a) => /blue-heron/i.test(a),
  },
  {
    name: "leave memory alone for a trivial task",
    prompt: "What is 17 * 3? Reply with the number only.",
    expect: (a, after, before) => /51/.test(a) && after.length === before,
  },
];

function ynm(cwd: string, home: string, ...args: string[]): string {
  const r = spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, YNM_HOME: home, YNM_USER: "eval" },
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

describe.skipIf(!hasClaude)("tier2 guidance efficacy (live)", () => {
  it("agent remembers and recalls at the right moments", async () => {
    let passed = 0;
    const details: string[] = [];
    for (const s of SCENARIOS) {
      const repo = await createRepo(1);
      const home = join(mkdtempSync(join(tmpdir(), "ynm-eval-home-")), ".ynm");
      ynm(repo, home, "init", "--no-hooks");
      ynm(repo, home, "client", "install", "claude-code");
      if (s.seed)
        ynm(
          repo,
          home,
          "remember",
          "--type",
          "semantic",
          "--level",
          "distributed",
          "--content",
          s.seed
        );
      const before = (JSON.parse(ynm(repo, home, "list", "--json")) as unknown[]).length;
      const mcpConfig = join(repo, ".mcp.json");
      writeFileSync(
        mcpConfig,
        JSON.stringify({
          mcpServers: {
            ynm: {
              command: "node",
              args: [mcpBin, "--stdio"],
              env: { YNM_HOME: home, YNM_USER: "eval" },
            },
          },
        })
      );
      const r = spawnSync(
        "claude",
        [
          "-p",
          s.prompt,
          "--model",
          MODEL,
          "--mcp-config",
          mcpConfig,
          "--strict-mcp-config",
          "--allowedTools",
          "mcp__ynm__*",
          "--output-format",
          "json",
          "--max-turns",
          "8",
        ],
        {
          cwd: repo,
          encoding: "utf8",
          timeout: 240_000,
          env: { ...process.env, YNM_HOME: home, YNM_USER: "eval" },
        }
      );
      let answer = "";
      try {
        answer = String((JSON.parse(r.stdout) as { result?: string }).result ?? "");
      } catch {
        answer = r.stdout;
      }
      const after = JSON.parse(ynm(repo, home, "list", "--json")) as Array<{ content: string }>;
      const ok =
        r.status === 0 &&
        s.expect(
          answer,
          after.map((m) => ({
            content: (m as { current?: { content?: string } }).current?.content ?? "",
          })),
          before
        );
      if (ok) passed += 1;
      details.push(
        `${ok ? "PASS" : "FAIL"} ${s.name}: ${answer.slice(0, 80).replace(/\n/g, " ")}${r.status !== 0 ? ` (exit ${r.status}: ${r.stderr.slice(0, 120)})` : ""}`
      );
    }
    console.info(details.join("\n"));
    const { regressed } = recordMetric(
      { name: `guidance:${MODEL}`, size: SCENARIOS.length, value: passed / SCENARIOS.length },
      0.34
    );
    expect(passed / SCENARIOS.length).toBeGreaterThanOrEqual(2 / 3);
    expect(regressed).toBe(false);
    expect(existsSync(mcpBin)).toBe(true);
  }, 900_000);
});
