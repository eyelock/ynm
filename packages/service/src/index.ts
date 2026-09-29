/**
 * @ynm/service: everything MCP and CLI call (ADR-008). Talks to the store and index seams only.
 */
export * from "./config.js";
export * from "./doctor.js";
export * from "./indexing.js";
export * from "./init.js";
export * from "./mounts.js";
export * from "./open.js";
export * from "./personal-store.js";
export * from "./redaction.js";
export * from "./worktree.js";
export * from "./ynm.js";
export const SERVICE_NAME = "ynm" as const;
