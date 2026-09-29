import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ftsQuery, SqliteIndex } from "./sqlite-index.js";
import { doc, runIndexConformance } from "./testing/conformance.js";

runIndexConformance("sqlite-fts", async () => {
  const ix = new SqliteIndex(join(mkdtempSync(join(tmpdir(), "ynm-ix-")), "index.sqlite"));
  await ix.open();
  return ix;
});

describe("SqliteIndex specifics", () => {
  it("builds a safe FTS query from free text", () => {
    expect(ftsQuery('root "commit" anchor')).toBe('"root" OR "commit" OR "anchor"');
    expect(ftsQuery("!!!")).toBeNull();
  });
  it("persists across open and close", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ynm-ix-")), "index.sqlite");
    const a = new SqliteIndex(file);
    await a.open();
    await a.upsert([doc({ content: "persisted root" })]);
    await a.close();
    const b = new SqliteIndex(file);
    await b.open();
    expect(await b.count()).toBe(1);
    expect((await b.search({ text: "persisted", limit: 5 })).length).toBe(1);
    await b.close();
  });
});
