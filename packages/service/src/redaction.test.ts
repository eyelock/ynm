import { DEFAULT_REDACTION } from "./config.js";
import { findRedactions } from "./redaction.js";

describe("redaction (ADR-007)", () => {
  it("flags secrets with the default patterns", () => {
    expect(findRedactions("key AKIAABCDEFGHIJKLMNOP here", DEFAULT_REDACTION)).toHaveLength(1);
    expect(
      findRedactions("Authorization: Bearer abcdefghijklmnopqrstuvwxyz", DEFAULT_REDACTION)
    ).toHaveLength(1);
    expect(findRedactions("-----BEGIN RSA PRIVATE KEY-----", DEFAULT_REDACTION)).toHaveLength(1);
  });
  it("passes ordinary text", () => {
    expect(findRedactions("We anchor notes to the root commit.", DEFAULT_REDACTION)).toEqual([]);
  });
  it("never echoes the full secret", () => {
    const [hit] = findRedactions("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234", DEFAULT_REDACTION);
    expect(hit?.sample.length).toBeLessThan(12);
  });
});
