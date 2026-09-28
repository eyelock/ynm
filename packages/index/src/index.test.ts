import { DEFAULT_INDEX } from "./index.js";

describe("@ynm/index", () => {
  it("defaults to SQLite FTS5 per ADR-005", () => {
    expect(DEFAULT_INDEX).toBe("sqlite-fts");
  });
});
