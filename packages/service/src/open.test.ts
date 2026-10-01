import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@ynm/store/testing/git";
import { openYnm } from "./open.js";

describe("openYnm outside a git repository", () => {
  function home(config?: Record<string, unknown>, envFile?: string): string {
    const dir = join(tempDir("ynm-open-"), ".ynm");
    mkdirSync(dir, { recursive: true });
    if (config) writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    if (envFile) writeFileSync(join(dir, "env"), envFile);
    return dir;
  }

  it("mounts only the personal store and loads secrets from the ynm home", async () => {
    const env: NodeJS.ProcessEnv = {
      YNM_HOME: home(undefined, "OPEN_TEST_MARKER=loaded\n"),
      YNM_PROVIDER: "memory",
      YNM_INDEX: "memory",
      YNM_NO_CLAUDE_CLI: "1",
    };
    const ctx = await openYnm({ cwd: tempDir("ynm-cwd-"), env, actor: "agent:test" });
    expect(ctx.worktree.isGitRepo).toBe(false);
    expect(ctx.mounts.map((m) => m.id)).toEqual(["personal"]);
    expect(env.OPEN_TEST_MARKER).toBe("loaded");
    expect(ctx.models.resolution).toEqual({
      judge: "auto: no model available",
      writer: "auto: no writer available",
    });
    const { memoryId } = await ctx.ynm.remember({ type: "semantic", content: "opened" });
    expect((await ctx.ynm.find(memoryId))?.current.provenance.actor).toBe("agent:test");
    expect((await ctx.ynm.recall({ text: "opened" }))[0]?.memoryId).toBe(memoryId);
  });

  it("does not probe for the claude CLI when an endpoint is configured or the writer is fixed", async () => {
    const endpoint = await openYnm({
      cwd: tempDir("ynm-cwd-"),
      noPersonal: true,
      env: {
        YNM_HOME: home(),
        YNM_PROVIDER: "memory",
        YNM_INDEX: "memory",
        YNM_OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
      },
    });
    expect(endpoint.mounts).toEqual([]);
    expect(endpoint.models.resolution.writer).toBe("auto: openai-compatible endpoint configured");

    const fixed = await openYnm({
      cwd: tempDir("ynm-cwd-"),
      noPersonal: true,
      env: {
        YNM_HOME: home({ dream: { writer: "none", judge: "heuristic" } }),
        YNM_INDEX: "memory",
      },
    });
    expect(fixed.models.resolution).toEqual({
      judge: "configured heuristic",
      writer: "configured none",
    });
    expect(fixed.loaded.files).toHaveLength(1);
  });
});
