import { keyFromRef, refFor, refPrefixFor, remoteRef } from "./refs.js";

describe("git notes refs (ADR-003)", () => {
  const key = {
    level: "distributed" as const,
    namespace: "org/eyelock/project/ynm",
    type: "semantic" as const,
    bucket: "2026-09",
  };
  it("maps a shard key to a ref and back", () => {
    const ref = refFor(key);
    expect(ref).toBe("refs/notes/ynm/shared/org/eyelock/project/ynm/semantic/2026-09");
    expect(keyFromRef(ref)).toEqual(key);
  });
  it("maps personal level to personal dir", () => {
    expect(refFor({ ...key, level: "personal" })).toContain("/ynm/personal/");
  });
  it("rejects malformed refs", () => {
    expect(keyFromRef("refs/notes/ynm/shared/x/semantic")).toBeNull();
    expect(keyFromRef("refs/notes/ynm/shared/x/nope/2026-09")).toBeNull();
    expect(keyFromRef("refs/notes/ynm/shared/x/semantic/2026-13")).toBeNull();
    expect(keyFromRef("refs/notes/other/shared/x/semantic/2026-09")).toBeNull();
  });
  it("builds prefixes and remote-tracking refs", () => {
    expect(refPrefixFor("distributed", "org")).toBe("refs/notes/ynm/shared/org/");
    expect(remoteRef("origin", refFor(key))).toBe(
      "refs/notes/ynm-remote/origin/shared/org/eyelock/project/ynm/semantic/2026-09"
    );
  });
});
