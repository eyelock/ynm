import { ULID_PATTERN, ulid, ulidTime } from "./ulid.js";

describe("ulid", () => {
  it("produces 26 Crockford base32 characters", () => {
    expect(ulid()).toMatch(ULID_PATTERN);
  });

  it("round-trips the timestamp", () => {
    const t = 1_700_000_000_000;
    expect(ulidTime(ulid(t))).toBe(t);
  });

  it("sorts by time", () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a < b).toBe(true);
  });

  it("is deterministic with an injected random source", () => {
    const source = () => {
      let n = 0;
      return () => {
        n += 0.137;
        return n % 1;
      };
    };
    const a = ulid(5, source());
    const b = ulid(5, source());
    expect(a).toBe(b);
  });

  it("is unique across many calls", () => {
    const seen = new Set(Array.from({ length: 5_000 }, () => ulid()));
    expect(seen.size).toBe(5_000);
  });
});
