import type { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

export interface StdioOptions {
  /** Refuse 2025-era clients instead of serving them. */
  rejectLegacy?: boolean;
}

/** Copied in spirit from mcp-toolkit's spec-update transport: one process, one client. */
export function startStdio(
  factory: () => McpServer,
  options: StdioOptions = {}
): { close: () => Promise<void> } {
  const handle = serveStdio(factory, {
    legacy: options.rejectLegacy ? "reject" : "serve",
    onerror: (error) => {
      // stderr only: stdout carries the protocol.
      console.error(`[ynm-mcp] ${error.message}`);
    },
  });
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { close: () => handle.close() };
}
