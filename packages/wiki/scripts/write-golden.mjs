// Regenerates the golden wiki pages from the same fixture the test uses. Review the diff before committing.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fold } from "@ynm/store";
import { generateWiki } from "../dist/generate.js";

const AT = "2026-09-29T00:00:00.000Z";
const base = { v: 1, op: "create", type: "semantic", level: "personal", namespace: "user/test", tags: [], links: [], content: "body", summary: "summary", recordedAt: "2026-09-01T00:00:00.000Z", provenance: { actor: "t" } };
const rec = (o) => ({ ...base, memoryId: o.id, ...o });
const records = [
  rec({ id: "01M0000000000000000000AAAA", subject: "entity:git-notes", tags: ["git", "storage"], summary: "Notes anchor to the root commit", content: "Notes anchor to the root commit.\n\nSecond paragraph.", recordedAt: "2026-09-01T00:00:00.000Z" }),
  rec({ id: "01M0000000000000000000BBBB", type: "episodic", subject: "entity:git-notes", tags: ["git"], summary: "Rebase lost nothing", content: "A rebase kept every note.", recordedAt: "2026-09-02T00:00:00.000Z" }),
  rec({ id: "01M0000000000000000000CCCC", type: "reflective", subject: "entity:git-notes", tags: [], summary: "Notes survive rewrites", content: "Because notes hang off the root commit, rewrites never touch them.", recordedAt: "2026-09-03T00:00:00.000Z", links: [{ rel: "derives-from", to: "01M0000000000000000000BBBB" }] }),
  rec({ id: "01M0000000000000000000DDDD", type: "procedural", level: "distributed", namespace: "common", tags: ["ci"], summary: "Run the gate", content: "Run pnpm gate before tagging.", data: { cmd: "pnpm gate" }, recordedAt: "2026-09-04T00:00:00.000Z", pinned: true }),
  rec({ id: "01M0000000000000000000EEEE", memoryId: "01M0000000000000000000AAAA", op: "tombstone", content: undefined, summary: undefined, reason: "obsolete", recordedAt: "2026-09-05T00:00:00.000Z" }),
];
const { memories } = fold(records);
const out = join(import.meta.dirname, "..", "test", "golden");
for (const p of generateWiki({ memories: memories.values(), records, generatedAt: AT, title: "Test memory" })) {
  mkdirSync(dirname(join(out, p.path)), { recursive: true });
  writeFileSync(join(out, p.path), p.content);
  console.log("wrote", p.path);
}
