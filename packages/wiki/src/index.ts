/**
 * @ynm/wiki: pure generator (fold -> pages) plus WikiTarget implementations (ADR-010).
 */
export * from "./generate.js";
export * from "./targets.js";
export const WIKI_TARGETS = ["directory", "orphan-branch", "notes-tree", "resources-only"] as const;
