import { WIKI_TARGETS } from "./index.js";

describe("@ynm/wiki", () => {
  it("lists the targets from ADR-010", () => {
    expect(WIKI_TARGETS).toContain("directory");
  });
});
