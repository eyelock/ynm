import { spawnSync } from "node:child_process";
import { resolveModels } from "@ynm/models";
import { addRedaction, traceEnv } from "@ynm/telemetry";
import { DEFAULT_REDACTION, loadConfig, loadEnvFile, ynmHome } from "./config.js";
import { defaultIndexLocator, IndexManager } from "./indexing.js";
import { openMounts } from "./mounts.js";
import { FileOAuthProvider } from "./remote/auth.js";
import { RemoteStore } from "./remote/store.js";
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
  // Telemetry redacts with the store's patterns as well as the defaults (ADR-018).
  addRedaction([...DEFAULT_REDACTION, ...loaded.config.redaction]);
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
      ? spawnSync("claude", ["--version"], {
          encoding: "utf8",
          timeout: 10_000,
          env: traceEnv(process.env),
        }).status === 0
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
  const remotes = (loaded.config.mounts ?? [])
    .filter((m) => m.provider === "mcp" && m.url)
    .map(
      (m) =>
        new RemoteStore({
          id: m.id,
          url: m.url as string,
          // Never a browser from here: a tool call cannot sign anyone in, `ynm login` does.
          authProvider: new FileOAuthProvider({
            home: loaded.home,
            mountId: m.id,
            url: m.url as string,
            onAuthorize: () => {
              throw new Error(`not signed in to ${m.id}: run \`ynm login ${m.id}\``);
            },
          }),
        })
    );
  const ynm = new Ynm({
    mounts,
    remotes,
    actor: opts.actor ?? (loaded.config.actor as string),
    userId: loaded.config.userId as string,
    redaction: loaded.config.redaction,
    index,
    models,
    dream: dreamCfg,
  });
  return { ynm, loaded, worktree, mounts, remotes, index, models };
}
