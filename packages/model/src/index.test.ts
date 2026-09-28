import { MODEL_SCHEMA_VERSION } from "./index.js";

describe("@ynm/model", () => {
  it("pins the record schema version", () => {
    expect(MODEL_SCHEMA_VERSION).toBe(1);
  });
});
