import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteAuthPath } from "@ynm/service";
import { testEnv, testYnmHome, unwrapped, ynmWith } from "../../test/helpers.js";

/** `ynm login` / `ynm logout` without a hosted store: the paths that need no browser. */
describe("ynm login and logout", () => {
  const dir = mkdtempSync(join(tmpdir(), "ynm-login-"));

  it("explains how to add a remote mount that is not configured", () => {
    const r = ynmWith(dir, {}, "login", "team");
    expect(r.status).not.toBe(0);
    expect(unwrapped(r.stderr)).toContain(
      `no remote mount "team": add {"id":"team","level":"distributed","provider":"mcp","url":"…"} to mounts in ~/.ynm/config.json`
    );
  });

  it("does not take a local mount for a remote one", () => {
    const env = testEnv({
      YNM_MOUNTS: JSON.stringify([
        { id: "local", level: "distributed", provider: "sqlite", path: join(dir, "l.sqlite") },
      ]),
    });
    const r = ynmWith(dir, { env }, "login", "local");
    expect(r.status).not.toBe(0);
    expect(unwrapped(r.stderr)).toContain(`no remote mount "local"`);
  });

  it("says when there is nothing to sign out of", () => {
    const r = ynmWith(dir, {}, "logout", "never");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("not signed in to never");
    const j = ynmWith(dir, {}, "logout", "never", "--json");
    expect(JSON.parse(j.stdout)).toEqual({ mount: "never", signedOut: false });
  });

  it("signs out by forgetting the stored sign-in", () => {
    const file = remoteAuthPath(testYnmHome, "gone");
    mkdirSync(join(testYnmHome, "auth"), { recursive: true });
    writeFileSync(file, JSON.stringify({ url: "https://memory.example.com/mcp" }));
    const r = ynmWith(dir, {}, "logout", "gone");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("signed out of gone");
    expect(ynmWith(dir, {}, "logout", "gone").stdout.trim()).toBe("not signed in to gone");
  });
});
