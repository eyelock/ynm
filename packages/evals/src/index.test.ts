import { MILESTONES } from "./index.js";

describe("@ynm/evals", () => {
  it("has one gate per milestone", () => {
    expect(MILESTONES).toHaveLength(7);
  });
});
