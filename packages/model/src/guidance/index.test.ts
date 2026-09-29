import { guidance, guidanceNames } from "./index.js";

describe("guidance", () => {
  it("loads every named document", () => {
    for (const n of guidanceNames()) expect(guidance(n)).toMatch(/^# /);
  });
});
