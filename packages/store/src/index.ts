/**
 * @ynm/store: the RecordLog seam (ADR-004). git notes is one provider, not the design.
 * Nothing above this package may import a provider directly; use the factory in service.
 */
export * from "./fold.js";
export * from "./lock.js";
export * from "./log.js";
export * from "./parse.js";
export { FsLog } from "./providers/fs.js";
export {
  type AnchorSelection,
  createRootCommit,
  findRootCommit,
  hasCommits,
  isShallow,
  selectAnchor,
} from "./providers/git-notes/anchor.js";
export {
  GitError,
  git,
  gitCommonDir,
  gitOrNull,
  gitStats,
  identityEnv,
} from "./providers/git-notes/git.js";
export { GitNotesLog, type GitNotesLogOptions } from "./providers/git-notes/provider.js";
export { keyFromRef, NOTES_PREFIX, REMOTE_PREFIX, refFor } from "./providers/git-notes/refs.js";
export { MemoryLog } from "./providers/memory.js";
export { SqliteLog } from "./providers/sqlite.js";
export const STORE_PROVIDERS = ["git-notes", "fs", "sqlite", "memory"] as const;
export type StoreProvider = (typeof STORE_PROVIDERS)[number];
