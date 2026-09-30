import { embedGuidance, guidance, guidanceNames } from "./index.js";

describe("guidance", () => {
  it("loads every named document", () => {
    for (const n of guidanceNames()) expect(guidance(n)).toMatch(/^# /);
  });

  it("prefers embedded text, as the release bundle registers it", () => {
    const disk = guidance("session-start");
    embedGuidance({ "session-start": "# embedded\n" });
    try {
      expect(guidance("session-start")).toBe("# embedded\n");
      expect(guidance("when-to-remember")).toMatch(/^# /);
    } finally {
      embedGuidance({});
    }
    expect(guidance("session-start")).toBe(disk);
  });
});
