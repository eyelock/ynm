import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig, loadEnvFile, MountConfigSchema } from "./config.js";

describe("config schema descriptions", () => {
  it("every mount key has a description", () => {
    const json = z.toJSONSchema(MountConfigSchema, { io: "input" }) as {
      properties: Record<string, { description?: string }>;
    };
    const missing = Object.entries(json.properties)
      .filter(([, p]) => !p.description)
      .map(([k]) => k);
    expect(missing).toEqual([]);
  });

  it("an s3 mount needs a bucket and no path; every other provider needs a path", () => {
    const s3 = { id: "h", level: "distributed", provider: "s3" };
    expect(MountConfigSchema.safeParse({ ...s3, bucket: "b", prefix: "p" }).success).toBe(true);
    expect(MountConfigSchema.safeParse(s3).error?.issues[0]).toMatchObject({
      path: ["bucket"],
      message: "an s3 mount needs a bucket",
    });
    expect(
      MountConfigSchema.safeParse({ id: "f", level: "personal", provider: "fs" }).error?.issues[0]
        ?.message
    ).toBe("a fs mount needs a path");
  });
});

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

  it("loads secrets from <home>/env without overriding existing values", () => {
    const h = mkdtempSync(join(tmpdir(), "ynm-env-"));
    writeFileSync(join(h, "env"), '# secrets\nexport TYPESAFE_API_KEY="abc"\nOTHER=1\n');
    const env: NodeJS.ProcessEnv = { OTHER: "keep" };
    expect(loadEnvFile(h, env).sort()).toEqual(["TYPESAFE_API_KEY"]);
    expect(env.TYPESAFE_API_KEY).toBe("abc");
    expect(env.OTHER).toBe("keep");
    expect(loadEnvFile(mkdtempSync(join(tmpdir(), "ynm-noenv-")), env)).toEqual([]);
  });

  it("takes mounts from YNM_MOUNTS, replacing those from files, and says what is wrong with it", () => {
    const h = mkdtempSync(join(tmpdir(), "ynm-mounts-"));
    writeFileSync(
      join(h, "config.json"),
      JSON.stringify({ mounts: [{ id: "file", level: "distributed", provider: "fs", path: "/a" }] })
    );
    const mounts = [{ id: "team", level: "distributed", provider: "sqlite", path: "/b.sqlite" }];
    const { config } = loadConfig({ home: h }, { YNM_MOUNTS: JSON.stringify(mounts) });
    expect(config.mounts).toEqual(mounts);
    expect(() => loadConfig({ home: h }, { YNM_MOUNTS: "[{" })).toThrow(
      /YNM_MOUNTS is not valid JSON/
    );
    expect(() => loadConfig({ home: h }, { YNM_MOUNTS: "{}" })).toThrow(/JSON array/);
    expect(() => loadConfig({ home: h }, { YNM_MOUNTS: '[{"id":"x"}]' })).toThrow();
  });

  it("carries dream defaults", () => {
    const { config } = loadConfig({ home: mkdtempSync(join(tmpdir(), "ynm-dream-")) }, {});
    expect(config.dream.thresholds.dedupe.act).toBe(0.85);
    expect(config.dream.judge).toBe("auto");
  });
});
