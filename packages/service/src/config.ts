import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { DreamConfigSchema } from "@ynm/model";
import { z } from "zod";

export const ShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "must be a git object id");

export const MountConfigSchema = z
  .object({
    id: z.string().min(1).describe("Mount id, shown on every hit and accepted by `--mount`"),
    level: z.enum(["personal", "distributed"]).describe("Which records the mount accepts"),
    provider: z
      .enum(["git-notes", "fs", "sqlite", "memory", "s3"])
      .default("git-notes")
      .describe("Record store provider for this mount"),
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Repository or directory path; required by every provider but `s3`"),
    anchor: ShaSchema.optional().describe("Anchor commit for this mount's notes"),
    remote: z.string().optional().describe("Remote used when syncing this mount"),
    bucket: z.string().min(1).optional().describe("`s3` only: the bucket that holds the store"),
    prefix: z
      .string()
      .optional()
      .describe("`s3` only: key prefix the store's objects sit under; default the bucket root"),
    region: z
      .string()
      .optional()
      .describe("`s3` only: AWS region of the bucket; default from the AWS environment"),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.provider === "s3" && !m.bucket)
      ctx.addIssue({ code: "custom", path: ["bucket"], message: "an s3 mount needs a bucket" });
    if (m.provider !== "s3" && !m.path)
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: `a ${m.provider} mount needs a path`,
      });
  });
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
    anchor: ShaSchema.optional().describe("Anchor commit for this repository's distributed notes"),
    remote: z.string().default("origin").describe("Remote used by sync"),
    provider: z
      .enum(["git-notes", "fs", "sqlite", "memory"])
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
    index: z.enum(["sqlite-fts", "memory"]).default("sqlite-fts").describe("Index implementation"),
    dream: DreamConfigSchema.prefault({}).describe("Judge, Writer and consolidation thresholds"),
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

/**
 * Secrets live in `<home>/env` (KEY=VALUE lines, mode 600, never in a repo) and are loaded into
 * the process environment without overriding values already set. Keys are never logged.
 */
export function loadEnvFile(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  name = "env"
): string[] {
  const file = join(dir, name);
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    let value = (m[2] as string).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (env[key] === undefined) {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
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
  if (env.YNM_INDEX) fromEnv.index = env.YNM_INDEX;
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
