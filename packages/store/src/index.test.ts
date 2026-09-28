import { STORE_PROVIDERS } from "./index.js";

describe("@ynm/store", () => {
  it("names the providers from ADR-004", () => {
    expect(STORE_PROVIDERS).toEqual(["git-notes", "fs", "sqlite", "memory"]);
  });
});
