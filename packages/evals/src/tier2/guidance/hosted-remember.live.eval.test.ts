/**
 * Tier 2 live eval: does Claude Code, connected to a hosted ynm server by URL alone, put a
 * "remember this" into ynm? The client gets only what MCP carries (server instructions and tool
 * descriptions): no hooks, no skill, no instruction-file block, no user settings. Its own
 * auto-memory stays on and Write is allowed, so the built-in memory is a real competitor, as it
 * is for a user who ran `claude mcp add --transport http`.
 *
 * Opt-in (YNM_EVAL_CLAUDE_CLI=1) because it spends tokens; skipped without the `claude` CLI.
 * Small on purpose: six prompts, one run each, few turns and a spend cap per run.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { recordMetric } from "../../baseline.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");
const cli = join(repoRoot, "packages", "cli", "bin", "run.js");
const mcpBin = join(repoRoot, "packages", "mcp", "bin", "run.js");
const MODEL = process.env.YNM_EVAL_MODEL ?? "claude-sonnet-4-5";
const TOKEN = "hosted-eval";
const enabled =
  process.env.YNM_EVAL_CLAUDE_CLI === "1" &&
  spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;

interface Case {
  prompt: string;
  /** A memory whose content matches is expected; null means nothing may be written. */
  expect: RegExp | null;
}

const CASES: Case[] = [
  { prompt: "Remember and call me DC all the time please.", expect: /\bDC\b/ },
  { prompt: "Call me DC from now on.", expect: /\bDC\b/ },
  { prompt: "Remember that our deploys happen on Tuesdays.", expect: /tuesday/i },
  { prompt: "From now on always use pnpm, never npm, in this project.", expect: /pnpm/i },
  { prompt: "What is 17 * 3? Reply with the number only.", expect: null },
  { prompt: "In one sentence, what does `git stash` do?", expect: null },
];

function env(home: string): NodeJS.ProcessEnv {
  return { ...process.env, YNM_HOME: home, YNM_USER: "eval", YNM_NO_CLAUDE_CLI: "1" };
}

function ynm(home: string, ...args: string[]): string {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", env: env(home) });
  if (r.status !== 0) throw new Error(`ynm ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
  });
}

async function startServer(
  store: string,
  home: string
): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort();
  const proc = spawn(
    "node",
    [
      mcpBin,
      "--http",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--token",
      TOKEN,
      "--no-personal",
      "--cwd",
      store,
    ],
    { env: env(home), stdio: "ignore" }
  );
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { url: `${base}/mcp`, proc };
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error("hosted server did not start");
}

/** Claude Code keeps a project's auto-memory under <config>/projects/<path with - for symbols>. */
function claudeProjectDirs(token: string): string[] {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  if (!existsSync(projects)) return [];
  return readdirSync(projects)
    .filter((d) => d.includes(token))
    .map((d) => join(projects, d));
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .length;
}

interface Outcome {
  ok: boolean;
  line: string;
}

async function runCase(c: Case): Promise<Outcome> {
  const root = mkdtempSync(join(tmpdir(), "ynm-hosted-eval-"));
  const token = basename(root).replace(/[^a-zA-Z0-9]/g, "-");
  const home = join(root, "home");
  const store = join(root, "store.git");
  const work = join(root, "work");
  mkdirSync(work);
  ynm(home, "init", "--bare", store);
  ynm(home, "init", "--cwd", store);
  const { url, proc } = await startServer(store, home);
  const mcpConfig = join(root, "mcp.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        ynm: { type: "http", url, headers: { Authorization: `Bearer ${TOKEN}` } },
      },
    })
  );
  try {
    const r = spawnSync(
      "claude",
      [
        "-p",
        c.prompt,
        "--model",
        MODEL,
        "--mcp-config",
        mcpConfig,
        "--strict-mcp-config",
        // No user, project or local settings: no hooks, no CLAUDE.md, no other servers.
        "--setting-sources",
        "",
        "--allowedTools",
        "mcp__ynm__*,Read,Write,Edit",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--max-turns",
        "4",
        "--max-budget-usd",
        "0.25",
      ],
      { cwd: work, encoding: "utf8", timeout: 180_000, env: process.env }
    );
    let answer = "";
    let denied = 0;
    try {
      const out = JSON.parse(r.stdout) as { result?: string; permission_denials?: unknown[] };
      answer = String(out.result ?? "");
      denied = out.permission_denials?.length ?? 0;
    } catch {
      answer = r.stdout || r.stderr;
    }
    const projectDirs = claudeProjectDirs(token);
    const builtIn =
      projectDirs.reduce((n, d) => n + countFiles(join(d, "memory")), 0) + countFiles(work);
    const memories = (
      JSON.parse(ynm(home, "list", "--json", "--cwd", store)) as Array<{
        current?: { content?: string };
      }>
    ).map((m) => m.current?.content ?? "");
    const ok = c.expect
      ? memories.some((m) => c.expect?.test(m) ?? false)
      : memories.length === 0 && builtIn === 0;
    const line = `${ok ? "PASS" : "FAIL"} ${JSON.stringify(c.prompt)}: ynm ${memories.length}, built-in ${builtIn}, denied ${denied}; ${answer.slice(0, 100).replace(/\n/g, " ")}`;
    for (const d of projectDirs) rmSync(d, { recursive: true, force: true });
    return { ok, line };
  } finally {
    proc.kill();
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!enabled)("tier2 hosted remember, URL-only client (live)", () => {
  it("Claude Code stores remember intents in a hosted ynm, not its own memory", async () => {
    expect(existsSync(mcpBin)).toBe(true);
    const outcomes: Outcome[] = [];
    for (const c of CASES) outcomes.push(await runCase(c));
    console.info(outcomes.map((o) => o.line).join("\n"));
    const positives = CASES.filter((c) => c.expect).length;
    const hits = outcomes.filter((o, i) => o.ok && CASES[i]?.expect).length;
    const passed = outcomes.filter((o) => o.ok).length;
    console.info(`remember hit rate ${hits}/${positives}; all cases ${passed}/${CASES.length}`);
    const { regressed } = recordMetric(
      { name: `hosted-remember:${MODEL}`, size: CASES.length, value: passed / CASES.length },
      0.34
    );
    expect(passed / CASES.length).toBeGreaterThanOrEqual(2 / 3);
    expect(regressed).toBe(false);
  }, 1_200_000);
});
