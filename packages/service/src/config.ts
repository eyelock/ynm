import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const ShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "must be a git object id");

export const MountConfigSchema = z
  .object({
    id: z.string().min(1),
    level: z.enum(["personal", "distributed"]),
    provider: z.enum(["git-notes", "fs", "memory"]).default("git-notes"),
    path: z.string().min(1).describe("Repository or directory path"),
    anchor: ShaSchema.optional(),
    remote: z.string().optional(),
  })
  .strict();
export type MountConfig = z.infer<typeof MountConfigSchema>;

/** Default redaction patterns applied before any distributed write (ADR-007). */
export const DEFAULT_REDACTION = [
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  "AKIA[0-9A-Z]{16}",
  "gh[pousr]_[A-Za-z0-9]{20,}",
  "sk-[A-Za-z0-9_-]{20,}",
  "xox[baprs]-[A-Za-z0-9-]{10,}",
  "(?i)bearer\\s+[A-Za-z0-9._-]{20,}",
];

export const YnmConfigSchema = z
  .object({
    anchor: ShaSchema.optional().describe("Anchor commit for this repository's shared notes"),
    remote: z.string().default("origin").describe("Remote used by sync"),
    provider: z
      .enum(["git-notes", "fs", "memory"])
      .default("git-notes")
      .describe("Default provider"),
    personalStore: z
      .string()
      .optional()
      .describe("Path of the personal bare repo; default ~/.ynm/store.git"),
    userId: z.string().optional().describe("Used for the default personal namespace user/<id>"),
    actor: z.string().optional().describe("Provenance actor for writes from this machine"),
    redaction: z
      .array(z.string())
      .default(DEFAULT_REDACTION)
      .describe("Regex patterns that block distributed writes"),
    mounts: z
      .array(MountConfigSchema)
      .optional()
      .describe("Explicit extra mounts (org stores, hosted stores)"),
    hooks: z.boolean().default(true).describe("Install git hooks on init"),
  })
  .strict();
export type YnmConfig = z.infer<typeof YnmConfigSchema>;

export interface ConfigSources {
  /** Home for ~/.ynm; defaults to YNM_HOME or the OS home. */
  home: string;
  /** Main repository path, when inside a git repo. */
  repo?: string;
  /** Current work tree path, when it differs from repo. */
  worktree?: string;
}

export interface LoadedConfig {
  config: YnmConfig;
  files: string[];
  home: string;
}

function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null)
    throw new Error(`${file}: expected a JSON object`);
  return parsed as Record<string, unknown>;
}

export function ynmHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.YNM_HOME ?? join(homedir(), ".ynm");
}

export function configPaths(src: ConfigSources): { global: string; repo?: string; local?: string } {
  return {
    global: join(src.home, "config.json"),
    repo: src.repo ? join(src.repo, ".ynm", "config.json") : undefined,
    local: join(src.worktree ?? src.repo ?? "", ".ynm", "config.local.json"),
  };
}

/**
 * defaults → ~/.ynm/config.json → <repo>/.ynm/config.json → <worktree>/.ynm/config.local.json
 * → YNM_* environment (ADR-009). Later layers override earlier ones key by key.
 */
export function loadConfig(src: ConfigSources, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const paths = configPaths(src);
  const files: string[] = [];
  let merged: Record<string, unknown> = {};
  for (const file of [
    paths.global,
    paths.repo,
    src.repo || src.worktree ? paths.local : undefined,
  ]) {
    if (!file) continue;
    const layer = readJson(file);
    if (layer) {
      merged = { ...merged, ...layer };
      files.push(file);
    }
  }
  const fromEnv: Record<string, unknown> = {};
  if (env.YNM_ANCHOR) fromEnv.anchor = env.YNM_ANCHOR;
  if (env.YNM_REMOTE) fromEnv.remote = env.YNM_REMOTE;
  if (env.YNM_PROVIDER) fromEnv.provider = env.YNM_PROVIDER;
  if (env.YNM_PERSONAL_STORE) fromEnv.personalStore = env.YNM_PERSONAL_STORE;
  if (env.YNM_USER) fromEnv.userId = env.YNM_USER;
  if (env.YNM_ACTOR) fromEnv.actor = env.YNM_ACTOR;
  merged = { ...merged, ...fromEnv };
  const config = YnmConfigSchema.parse(merged);
  config.userId ??= safeUsername();
  config.personalStore ??= join(src.home, "store.git");
  config.actor ??= `user:${config.userId}`;
  return { config, files, home: src.home };
}

function safeUsername(): string {
  try {
    return (
      userInfo()
        .username.toLowerCase()
        .replace(/[^a-z0-9._-]/g, "-") || "me"
    );
  } catch {
    return "me";
  }
}
