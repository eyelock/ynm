import { MemoryLog } from "@ynm/store";
import { DEFAULT_REDACTION } from "./config.js";
import { IndexManager } from "./indexing.js";
import { ingestWikiPage, wikiPages } from "./wiki.js";
import { Ynm } from "./ynm.js";

/** The body copy, not the page title that precedes it. */
const LAST_TUESDAYS = /Tuesdays(?![\s\S]*Tuesdays)/;

function makeYnm(): Ynm {
  return new Ynm({
    mounts: [
      { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
    ],
    actor: "t",
    userId: "u",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
  });
}

async function pageFor(y: Ynm, memoryId: string): Promise<string> {
  const mount = y.mounts[0];
  if (!mount) throw new Error("no mount");
  const pages = await wikiPages(y, mount);
  return pages.find((p) => p.path === `memories/${memoryId}.md`)?.content ?? "";
}

describe("wiki ingest", () => {
  it("derives a fresh summary when the content changed and the title was not edited", async () => {
    const y = makeYnm();
    const { memoryId } = await y.remember({ type: "semantic", content: "Standup is on Tuesdays" });
    const page = await pageFor(y, memoryId);
    const res = await ingestWikiPage(y, page.replace(LAST_TUESDAYS, "Wednesdays"));
    expect(res.changed).toBe(true);
    const m = await y.find(memoryId);
    expect(m?.current.content).toBe("Standup is on Wednesdays");
    expect(m?.current.summary).toBe("Standup is on Wednesdays");
  });

  it("keeps an explicitly edited page title as the summary", async () => {
    const y = makeYnm();
    const { memoryId } = await y.remember({ type: "semantic", content: "Standup is on Tuesdays" });
    const page = await pageFor(y, memoryId);
    const edited = page
      .replace(LAST_TUESDAYS, "Wednesdays")
      .replace("# Standup is on Tuesdays", "# Standup day");
    await ingestWikiPage(y, edited);
    expect((await y.find(memoryId))?.current.summary).toBe("Standup day");
  });
});
