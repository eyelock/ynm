import type { MemoryRecord } from "@ynm/model";
import { MemoryRecordSchema } from "@ynm/model";

export interface ParsedLines {
  records: MemoryRecord[];
  problems: Array<{ line: number; message: string }>;
}

/**
 * Parses JSONL tolerantly (NFR-7): a bad line is reported and skipped, never fatal. Duplicate
 * record ids (possible after a cat_sort_uniq merge that saw both sides) collapse to one.
 */
export function parseJsonl(text: string): ParsedLines {
  const records: MemoryRecord[] = [];
  const problems: ParsedLines["problems"] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      problems.push({ line: i + 1, message: `invalid JSON: ${(err as Error).message}` });
      continue;
    }
    const parsed = MemoryRecordSchema.safeParse(raw);
    if (!parsed.success) {
      const v = (raw as { v?: unknown })?.v;
      const why =
        typeof v === "number" && v !== 1
          ? `unknown schema version ${v}`
          : (parsed.error.issues[0]?.message ?? "invalid record");
      problems.push({ line: i + 1, message: why });
      continue;
    }
    if (seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    records.push(parsed.data);
  }
  return { records, problems };
}

/** One record per line, newline-terminated, so cat_sort_uniq sees whole records. */
export function serializeJsonl(records: readonly MemoryRecord[]): string {
  if (records.length === 0) return "";
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}
