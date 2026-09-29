/**
 * @ynm/mcp: server entry. `ynm-mcp --stdio` (default) or `ynm-mcp --http [--port N] [--token T]`.
 */
import { createYnmServer, serviceCache } from "./server.js";
import { startHttp } from "./transport/http.js";
import { startStdio } from "./transport/stdio.js";

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
  rejectLegacy: boolean;
  noPersonal: boolean;
  version: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    mode: argv.includes("--http") ? "http" : "stdio",
    cwd: value("--cwd") ?? process.cwd(),
    port: value("--port") ? Number(value("--port")) : undefined,
    host: value("--host"),
    token: value("--token") ?? process.env.YNM_MCP_TOKEN,
    allowOrigin: value("--allow-origin")
      ?.split(",")
      .map((s) => s.trim()),
    rejectLegacy: argv.includes("--modern-only"),
    noPersonal: argv.includes("--no-personal"),
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
    await startHttp(factory, {
      port: args.port,
      host: args.host,
      authToken: args.token,
      allowedOrigins: args.allowOrigin,
      rejectLegacy: args.rejectLegacy,
    });
    return;
  }
  startStdio(factory, { rejectLegacy: args.rejectLegacy });
}
