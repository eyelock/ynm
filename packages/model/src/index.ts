/**
 * @ynm/model: the single source of truth for record shapes (ADR-002), memory types and scopes
 * (ADR-001), inputs shared by MCP and CLI (ADR-008). Nothing here touches storage.
 */
export * from "./record.js";
export * from "./ulid.js";
