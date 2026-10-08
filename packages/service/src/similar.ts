import type { Ynm } from "./ynm.js";

export interface SimilarMemory {
  memoryId: string;
  summary: string;
}

/** Minimum overlap coefficient of the two texts' words for a recall hit to count as similar. */
export const SIMILAR_MIN_OVERLAP = 0.6;

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "are",
  "was",
  "use",
  "uses",
]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
  );
}

/** |A∩B| / min(|A|,|B|) over the words of two texts; 0 when either has none. */
export function overlapCoefficient(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  const min = Math.min(x.size, y.size);
  if (!min) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / min;
}

/**
 * Memories already stored that resemble `content`, other than `exceptId` (the one just written):
 * a recall on the first 200 characters, at most four, kept only when their words overlap
 * enough (`SIMILAR_MIN_OVERLAP`) with the new content. Empty without an index. Never refuses; it
 * only informs, so a caller can point at `supersede` instead of leaving a duplicate.
 */
export async function similarMemories(
  ynm: Ynm,
  content: string,
  exceptId: string
): Promise<SimilarMemory[]> {
  if (!ynm.index) return [];
  const hits = await ynm.recall({ text: content.slice(0, 200), limit: 4 });
  return hits
    .filter((h) => h.memoryId !== exceptId)
    .filter((h) => overlapCoefficient(content, h.content || h.summary) >= SIMILAR_MIN_OVERLAP)
    .map((h) => ({ memoryId: h.memoryId, summary: h.summary }));
}

/**
 * The warning for a non-empty `similar`, shared by the MCP tool and the CLI. `supersede` names
 * the way to replace a memory in the caller's own terms: the tool name, or the command.
 */
export function similarGuidance(similar: SimilarMemory[], supersede: string): string | undefined {
  if (!similar.length) return undefined;
  const list = similar.map((h) => `${h.memoryId} (${h.summary})`).join("; ");
  return `${similar.length} similar memor${similar.length === 1 ? "y exists" : "ies exist"}: ${list}. If one of them is the same fact, prefer ${supersede} over a duplicate.`;
}
