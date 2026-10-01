import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createRepo, tempDir } from "../../testing/git-fixtures.js";
import { assertSha, GitError, git, gitCommonDir, gitOrNull, gitStats, identityEnv } from "./git.js";

describe("git", () => {
  it("returns stdout, passes stdin and counts spawns", async () => {
    const repo = await createRepo(0);
    const before = gitStats.spawned;
    const sha = (await git(["hash-object", "--stdin"], { cwd: repo, input: "hello\n" })).trim();
    expect(sha).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(gitStats.spawned).toBe(before + 1);
  });

  it("rejects with a GitError carrying args, stderr and exit code", async () => {
    const repo = await createRepo(0);
    const err = await git(["rev-parse", "--verify", "nope"], { cwd: repo }).catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err.name).toBe("GitError");
    expect(err.args).toEqual(["rev-parse", "--verify", "nope"]);
    expect(err.code).toBe(128);
    expect(err.stderr).toMatch(/fatal/);
    expect(err.message).toMatch(/^git rev-parse --verify nope failed \(128\): fatal/);
  });

  it("rejects with ENOENT when the process cannot be spawned", async () => {
    const missing = join(tempDir(), "does-not-exist");
    const err = await git(["status"], { cwd: missing }).catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err.code).toBe("ENOENT");
  });

  it("gitOrNull swallows failures", async () => {
    const repo = await createRepo(0);
    expect(await gitOrNull(["rev-parse", "--verify", "-q", "HEAD"], { cwd: repo })).toBeNull();
    expect(await gitOrNull(["rev-parse", "--is-bare-repository"], { cwd: repo })).toBe("false\n");
  });
});

describe("identityEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds nothing when the repo has a user.email", async () => {
    const repo = await createRepo(0);
    await git(["config", "user.email", "me@example.com"], { cwd: repo });
    expect(await identityEnv(repo)).toEqual({});
  });

  it("falls back to a ynm identity when no user.email is configured anywhere", async () => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
    const repo = await createRepo(0);
    expect(await identityEnv(repo)).toEqual({
      GIT_AUTHOR_NAME: "ynm",
      GIT_AUTHOR_EMAIL: "ynm@localhost",
      GIT_COMMITTER_NAME: "ynm",
      GIT_COMMITTER_EMAIL: "ynm@localhost",
    });
  });
});

describe("assertSha", () => {
  it("accepts SHA-1 and SHA-256 object ids", () => {
    expect(() => assertSha("a".repeat(40))).not.toThrow();
    expect(() => assertSha("b".repeat(64))).not.toThrow();
  });
  it.each(["HEAD", "A".repeat(40), "a".repeat(39), "a".repeat(50), ""])("rejects %j", (s) => {
    expect(() => assertSha(s)).toThrow(`not an object id: ${s}`);
  });
});

describe("gitCommonDir", () => {
  it("returns the absolute .git directory of a work tree", async () => {
    const repo = await createRepo(1);
    expect(realpathSync(await gitCommonDir(repo))).toBe(realpathSync(join(repo, ".git")));
  });
});
