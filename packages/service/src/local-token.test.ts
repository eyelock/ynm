import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureLocalToken,
  localTokenPath,
  readLocalToken,
  rotateLocalToken,
} from "./local-token.js";

const home = () => join(mkdtempSync(join(tmpdir(), "ynm-token-")), ".ynm");

describe("local token (ADR-017)", () => {
  it("creates the token file readable only by the user, in a directory only they can enter", () => {
    const h = home();
    const { token, created, path } = ensureLocalToken(h);
    expect(created).toBe(true);
    expect(path).toBe(localTokenPath(h));
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(h).mode & 0o077).toBe(0);
    expect(readLocalToken(h)).toBe(token);
  });

  it("keeps the token it made, and makes a file left open private again", async () => {
    const h = home();
    const first = ensureLocalToken(h);
    const { chmodSync } = await import("node:fs");
    chmodSync(first.path, 0o644);
    const again = ensureLocalToken(h);
    expect(again).toMatchObject({ token: first.token, created: false });
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
  });

  it("rotates to a new token, still private", () => {
    const h = home();
    const first = ensureLocalToken(h);
    const next = rotateLocalToken(h);
    expect(next.token).not.toBe(first.token);
    expect(readLocalToken(h)).toBe(next.token);
    expect(statSync(next.path).mode & 0o777).toBe(0o600);
  });

  it("reads nothing when there is no file", () => {
    expect(readLocalToken(home())).toBeUndefined();
  });
});
