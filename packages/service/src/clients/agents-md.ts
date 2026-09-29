import { existsSync, readFileSync } from "node:fs";
import { guidance } from "@ynm/model";
import type { Change } from "./types.js";

export const AGENTS_MD_MARKER = "<!-- ynm:guidance -->";

/** The block appended to AGENTS.md (Copilot CLI, OpenCode, Pi all read it), delimited for idempotent re-installs. */
export function agentsMdBlock(): string {
  return `${AGENTS_MD_MARKER}\n${guidance("session-start").trim()}\n${AGENTS_MD_MARKER}\n`;
}

/** A write change for `file` that replaces an existing delimited block or appends one; nothing when unchanged. */
export function delimitedBlockChange(
  file: string,
  block: string,
  marker: string,
  reason: string
): Change | null {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const stripped = existing.includes(marker)
    ? existing.replace(new RegExp(`${marker}[\\s\\S]*?${marker}\\n?`), "")
    : existing;
  const content = `${stripped.trimEnd()}${stripped.trim() ? "\n\n" : ""}${block}`;
  if (content === existing) return null;
  return { kind: "write", path: file, content, reason };
}
