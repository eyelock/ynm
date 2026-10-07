/**
 * @ynm/mcp: server entry. `ynm-mcp --stdio` (default) or
 * `ynm-mcp --http [--port N] [--host H] [--token T] [--no-personal] [--dream-every 15m] [--sync-every 5m]`.
 * Hosted auth comes from the environment (see auth.ts): YNM_MCP_TOKEN, YNM_OAUTH_INTROSPECTION_URL
 * or YNM_JWKS_URL.
 */
import { DEFAULT_REDACTION } from "@ynm/service";
import { shutdownTelemetry, startTelemetry } from "@ynm/telemetry";
import { authFromEnv, protectedResourceFor, verifierFor } from "./auth.js";
import { hostedAudit } from "./identity.js";
import { parseEvery, startScheduler } from "./scheduler.js";
import { createYnmServer, serviceCache } from "./server.js";
import { startHttp } from "./transport/http.js";
import { startStdio } from "./transport/stdio.js";
import { MCP_VERSION } from "./version.js";

export * from "./auth.js";
export * from "./scheduler.js";
export { createYnmServer, serverInstructions, serviceCache } from "./server.js";
export {
  createFrontDoor,
  createWebHandler,
  type FrontDoorOptions,
  type FrontDoorResult,
  type HttpHandle,
  type HttpOptions,
  startHttp,
  type WebHandler,
  type WebHandlerOptions,
} from "./transport/http.js";
export { startStdio } from "./transport/stdio.js";
export { MCP_VERSION } from "./version.js";

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
  "memory_people",
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
    process.stdout.write(`ynm-mcp ${MCP_VERSION}\n`);
    return;
  }
  // Telemetry starts before the store opens, so store calls are spans; with no OTLP endpoint and
  // no ynr spool nothing is loaded (ADR-018). A server is long-lived, so with neither it looks
  // for the spool again once a minute.
  // A stdio server ends when its client closes stdin, so its exports are bounded as a command's.
  await startTelemetry({
    version: MCP_VERSION,
    redaction: DEFAULT_REDACTION,
    bridgeConsole: true,
    recheck: true,
    exportTimeoutMs: args.mode === "stdio" ? 2000 : undefined,
  });
  const opts = { cwd: args.cwd, noPersonal: args.noPersonal };
  const getYnm = serviceCache(opts);
  // Open the store up front so the instructions name the levels actually served; a store that
  // fails to open still serves, and each tool call reports the failure.
  const levels = await getYnm().then(
    (y) => [...new Set(y.mounts.map((m) => m.level))],
    () => undefined
  );
  const factory = () => createYnmServer({ ...opts, levels, version: MCP_VERSION }, getYnm);
  if (args.mode === "http") {
    const auth = args.token ? { mode: "bearer" as const, tokens: [args.token] } : authFromEnv();
    const requiredScopes = process.env.YNM_REQUIRED_SCOPES?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
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
      requiredScopes,
      protectedResource: protectedResourceFor(auth, process.env, requiredScopes),
      allowedOrigins: args.allowOrigin,
      allowedHosts,
      rejectLegacy: args.rejectLegacy,
      health: () => ({ auth: auth.mode, scheduler: scheduler.stats }),
      ...hostedAudit(process.env, auth.mode !== "none", getYnm),
    });
    console.error(`ynm-mcp auth: ${auth.mode}`);
    const shutdown = async () => {
      scheduler.stop();
      await handle.close();
      await shutdownTelemetry();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    return;
  }
  startStdio(factory, { rejectLegacy: args.rejectLegacy });
}
