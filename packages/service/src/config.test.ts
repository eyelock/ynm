import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

describe("loadConfig (ADR-009)", () => {
  const home = mkdtempSync(join(tmpdir(), "ynm-home-"));
  const repo = mkdtempSync(join(tmpdir(), "ynm-repo-"));
  const wt = mkdtempSync(join(tmpdir(), "ynm-wt-"));
  const sha = "a".repeat(40);

  it("layers global, repo, local and env in that order", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ remote: "global", userId: "g" }));
    mkdirSync(join(repo, ".ynm"));
    writeFileSync(
      join(repo, ".ynm", "config.json"),
      JSON.stringify({ remote: "repo", anchor: sha })
    );
    mkdirSync(join(wt, ".ynm"));
    writeFileSync(join(wt, ".ynm", "config.local.json"), JSON.stringify({ remote: "local" }));
    const { config, files } = loadConfig({ home, repo, worktree: wt }, {});
    expect(files).toHaveLength(3);
    expect(config.remote).toBe("local");
    expect(config.anchor).toBe(sha);
    expect(config.userId).toBe("g");
    expect(config.personalStore).toBe(join(home, "store.git"));
    const env = loadConfig({ home, repo, worktree: wt }, { YNM_REMOTE: "env" });
    expect(env.config.remote).toBe("env");
  });

  it("works with no files at all", () => {
    const { config, files } = loadConfig({ home: mkdtempSync(join(tmpdir(), "ynm-empty-")) }, {});
    expect(files).toEqual([]);
    expect(config.remote).toBe("origin");
    expect(config.redaction.length).toBeGreaterThan(3);
    expect(config.actor).toMatch(/^user:/);
  });

  it("rejects unknown keys and bad anchors", () => {
    const h = mkdtempSync(join(tmpdir(), "ynm-bad-"));
    writeFileSync(join(h, "config.json"), JSON.stringify({ anchor: "nope" }));
    expect(() => loadConfig({ home: h }, {})).toThrow();
  });
});
