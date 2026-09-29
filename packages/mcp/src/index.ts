/**
 * @ynm/mcp: server entry. `ynm-mcp --stdio` (default) or
 * `ynm-mcp --http [--port N] [--host H] [--token T] [--no-personal] [--dream-every 15m] [--sync-every 5m]`.
 * Hosted auth comes from the environment (see auth.ts): YNM_MCP_TOKEN, YNM_OAUTH_INTROSPECTION_URL
 * or YNM_JWKS_URL.
 */
import { authFromEnv, verifierFor } from "./auth.js";
import { parseEvery, startScheduler } from "./scheduler.js";
import { createYnmServer, serviceCache } from "./server.js";
import { startHttp } from "./transport/http.js";
import { startStdio } from "./transport/stdio.js";

export * from "./auth.js";
export * from "./scheduler.js";
export { createYnmServer, serviceCache } from "./server.js";
export { type HttpHandle, type HttpOptions, startHttp } from "./transport/http.js";
export { startStdio } from "./transport/stdio.js";

export const MCP_TOOLS = [
  "memory_remember",
  "memory_recall",
  "memory_context",
  "memory_supersede",
  "memory_annotate",
  "memory_forget",
  "memory_session",
  "memory_consolidate",
  "memory_sync",
  "memory_status",
] as const;

export interface CliArgs {
  mode: "stdio" | "http";
  cwd: string;
  port?: number;
  host?: string;
  token?: string;
  allowOrigin?: string[];
  allowHost?: string[];
  rejectLegacy: boolean;
  noPersonal: boolean;
  dreamEvery?: string;
  syncEvery?: string;
  version: boolean;
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const list = (flag: string): string[] | undefined =>
    value(flag)
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    mode: argv.includes("--http") ? "http" : "stdio",
    cwd: value("--cwd") ?? process.cwd(),
    port: value("--port") ? Number(value("--port")) : env.PORT ? Number(env.PORT) : undefined,
    host: value("--host") ?? env.YNM_HTTP_HOST,
    token: value("--token"),
    allowOrigin: list("--allow-origin") ?? list("--allow-origin"),
    allowHost:
      list("--allow-host") ??
      (env.YNM_ALLOWED_HOSTS ? env.YNM_ALLOWED_HOSTS.split(",").map((s) => s.trim()) : undefined),
    rejectLegacy: argv.includes("--modern-only"),
    noPersonal: argv.includes("--no-personal"),
    dreamEvery: value("--dream-every") ?? env.YNM_DREAM_EVERY,
    syncEvery: value("--sync-every") ?? env.YNM_SYNC_EVERY,
    version: argv.includes("--version"),
  };
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.version) {
    process.stdout.write("ynm-mcp 0.1.0\n");
    return;
  }
  const opts = { cwd: args.cwd, noPersonal: args.noPersonal };
  const getYnm = serviceCache(opts);
  const factory = () => createYnmServer(opts, getYnm);
  if (args.mode === "http") {
    const auth = args.token ? { mode: "bearer" as const, tokens: [args.token] } : authFromEnv();
    const scheduler = startScheduler(getYnm, {
      dreamEveryMs: parseEvery(args.dreamEvery),
      syncEveryMs: parseEvery(args.syncEvery),
    });
    // Bind to all interfaces only when asked; then the Host header is whatever the operator allows.
    const host = args.host ?? "localhost";
    const allowedHosts =
      args.allowHost ?? (host === "0.0.0.0" || host === "::" ? ["*"] : undefined);
    const handle = await startHttp(factory, {
      port: args.port,
      host,
      verifier: verifierFor(auth),
      requiredScopes: process.env.YNM_REQUIRED_SCOPES?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      allowedOrigins: args.allowOrigin,
      allowedHosts,
      rejectLegacy: args.rejectLegacy,
      health: () => ({ auth: auth.mode, scheduler: scheduler.stats }),
    });
    console.error(`ynm-mcp auth: ${auth.mode}`);
    const shutdown = async () => {
      scheduler.stop();
      await handle.close();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    return;
  }
  startStdio(factory, { rejectLegacy: args.rejectLegacy });
}
