/**
 * @ynm/store: the RecordLog seam (ADR-004). git notes is one provider, not the design.
 */
export const STORE_PROVIDERS = ["git-notes", "fs", "sqlite", "memory"] as const;
export type StoreProvider = (typeof STORE_PROVIDERS)[number];
