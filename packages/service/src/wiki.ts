import { join } from "node:path";
import { authorName, type MemoryRecord, personOfActor } from "@ynm/model";
import { fold } from "@ynm/store";
import {
  DirectoryTarget,
  generateWiki,
  OrphanBranchTarget,
  parseMemoryPage,
  type WikiPage,
  type WikiTarget,
} from "@ynm/wiki";
import type { Mount } from "./mounts.js";
import type { Ynm } from "./ynm.js";

export interface WikiBuildOptions {
  mount?: string;
  target?: "directory" | "orphan-branch";
  /** For directory targets; default <home>/wiki/<mount> or <repo>/.ynm/wiki for the project. */
  dir?: string;
  home: string;
  repo?: string;
}

export function defaultWikiDir(mount: Mount, home: string, repo?: string): string {
  return mount.id === "project" && repo ? join(repo, ".ynm", "wiki") : join(home, "wiki", mount.id);
}

export function wikiTarget(mount: Mount, opts: WikiBuildOptions): WikiTarget {
  if (opts.target === "orphan-branch") {
    if (mount.log.provider !== "git-notes")
      throw new Error(`mount ${mount.id} is not a git repository; use the directory target`);
    return new OrphanBranchTarget(mount.location);
  }
  return new DirectoryTarget(opts.dir ?? defaultWikiDir(mount, opts.home, opts.repo));
}

/** Pages for one mount, generated from the fold (ADR-010). */
export async function wikiPages(ynm: Ynm, mount: Mount): Promise<WikiPage[]> {
  const records: MemoryRecord[] = [];
  for await (const r of mount.log.scan()) records.push(r);
  const { memories } = fold(records);
  const people = await ynm.people();
  return generateWiki({
    memories: memories.values(),
    records,
    title: `Memory: ${mount.id}`,
    author: (actor) => (personOfActor(actor) ? authorName(actor, people) : undefined),
  });
}

export async function buildWiki(
  ynm: Ynm,
  opts: WikiBuildOptions
): Promise<Array<{ mount: string; written: number; location: string }>> {
  const out = [];
  for (const mount of ynm.mounts) {
    if (opts.mount && mount.id !== opts.mount) continue;
    const pages = await wikiPages(ynm, mount);
    const res = await wikiTarget(mount, opts).write(pages);
    out.push({ mount: mount.id, ...res });
  }
  return out;
}

/** An edited memory page becomes a supersede when its content changed (ADR-010). */
export async function ingestWikiPage(
  ynm: Ynm,
  text: string
): Promise<{ memoryId: string; changed: boolean }> {
  const parsed = parseMemoryPage(text);
  if (!parsed) throw new Error("not a memory page: missing frontmatter with memoryId");
  const m = await ynm.find(parsed.memoryId);
  if (!m) throw new Error(`unknown memory ${parsed.memoryId}`);
  if ((m.current.content ?? "").trim() === parsed.content.trim())
    return { memoryId: parsed.memoryId, changed: false };
  // The content changed, so the stored summary is stale: keep a summary only when the page title
  // was itself edited, otherwise let supersede derive a fresh one from the new content.
  const titleEdited =
    parsed.summary !== undefined &&
    parsed.summary !== parsed.memoryId &&
    parsed.summary !== m.current.summary;
  await ynm.supersede({
    memoryId: parsed.memoryId,
    content: parsed.content,
    summary: titleEdited ? parsed.summary : undefined,
    tags: [],
    links: [],
  });
  return { memoryId: parsed.memoryId, changed: true };
}
