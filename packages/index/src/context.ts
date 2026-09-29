import { estimateTokens } from "./tokens.js";
import type { IndexedMemory, Ranked } from "./types.js";

export interface ContextBlock {
  markdown: string;
  included: string[];
  tokens: number;
  truncated: boolean;
}

function line(m: IndexedMemory): string {
  const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
  return `- (${m.type}${m.pinned ? ", pinned" : ""}) ${m.summary || m.content.split("\n")[0] || ""}${tags}`;
}

/**
 * The always-in-context tier (ADR-005): pinned memories first, then ranked ones, packed to a
 * token budget. One line per memory so the block stays cheap; full content is a recall away.
 */
export function buildContext(
  pinned: IndexedMemory[],
  ranked: Ranked[],
  byId: Map<string, IndexedMemory>,
  budgetTokens: number,
  title = "Memory"
): ContextBlock {
  const header = `## ${title}\n`;
  let tokens = estimateTokens(header);
  const lines: string[] = [];
  const included: string[] = [];
  let truncated = false;
  const push = (m: IndexedMemory): boolean => {
    const l = line(m);
    const t = estimateTokens(l);
    if (tokens + t > budgetTokens) {
      truncated = true;
      return false;
    }
    tokens += t;
    lines.push(l);
    included.push(m.memoryId);
    return true;
  };
  for (const m of pinned) if (!push(m)) break;
  for (const r of ranked) {
    if (included.includes(r.memoryId)) continue;
    const m = byId.get(r.memoryId);
    if (m && !push(m)) break;
  }
  return { markdown: `${header}${lines.join("\n")}\n`, included, tokens, truncated };
}
