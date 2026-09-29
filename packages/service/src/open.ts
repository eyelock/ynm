import { spawnSync } from "node:child_process";
import { resolveModels } from "@ynm/models";
import { loadConfig, loadEnvFile, ynmHome } from "./config.js";
import { defaultIndexLocator, IndexManager } from "./indexing.js";
import { openMounts } from "./mounts.js";
import { detectWorktree } from "./worktree.js";
import { Ynm } from "./ynm.js";

export interface OpenOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  noPersonal?: boolean;
  actor?: string;
}

/** Everything a CLI command or MCP tool needs, from a working directory. */
export async function openYnm(opts: OpenOptions = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const worktree = await detectWorktree(cwd);
  // Secrets: ~/.ynm/env first, then a gitignored .env at the repo root; never overriding set values.
  loadEnvFile(ynmHome(env), env);
  if (worktree.isGitRepo) loadEnvFile(worktree.mainRepoPath, env, ".env");
  const loaded = loadConfig(
    {
      home: ynmHome(env),
      repo: worktree.isGitRepo ? worktree.mainRepoPath : undefined,
      worktree: worktree.isGitRepo ? worktree.currentPath : undefined,
    },
    env
  );
  const mounts = await openMounts({ loaded, worktree, noPersonal: opts.noPersonal });
  const index = new IndexManager(
    loaded.config.index,
    defaultIndexLocator(loaded.home, worktree.isGitRepo ? worktree.mainRepoPath : undefined)
  );
  const dreamCfg = loaded.config.dream;
  const needsProbe =
    dreamCfg.writer === "auto" && !env[dreamCfg.openai.apiKeyEnv] && !env.YNM_OPENAI_BASE_URL;
  const claudeCli =
    needsProbe && env.YNM_NO_CLAUDE_CLI !== "1"
      ? spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000 }).status === 0
      : false;
  const models = resolveModels(
    {
      judge: dreamCfg.judge,
      writer: dreamCfg.writer,
      typesafe: dreamCfg.typesafe,
      openai: dreamCfg.openai,
      claude: dreamCfg.claude,
    },
    env,
    { claudeCli }
  );
  const ynm = new Ynm({
    mounts,
    actor: opts.actor ?? (loaded.config.actor as string),
    userId: loaded.config.userId as string,
    redaction: loaded.config.redaction,
    index,
    models,
    dream: dreamCfg,
  });
  return { ynm, loaded, worktree, mounts, index, models };
}
