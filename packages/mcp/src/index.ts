/**
 * @ynm/mcp: server entry. Transports arrive in M3 (copied from mcp-toolkit spec-update).
 */
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

export async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes("--version")) {
    process.stdout.write("ynm-mcp 0.1.0\n");
    return;
  }
  throw new Error("ynm-mcp: transports are not implemented yet (milestone M3)");
}
