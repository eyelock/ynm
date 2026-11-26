import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Docker image's entrypoint (ADR-017), run with stub `ynm` and `git` on PATH that record their
// arguments, so what the container would start is checked without Docker.
const entrypoint = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../infra/docker/entrypoint.sh"
);

function run(env: Record<string, string>, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "ynm-entry-"));
  const log = join(dir, "calls.log");
  for (const name of ["ynm", "git"]) {
    const stub = join(dir, name);
    writeFileSync(stub, `#!/bin/sh\necho "${name} $*" >> "${log}"\n`);
    chmodSync(stub, 0o755);
  }
  const r = spawnSync("sh", [entrypoint, ...args], {
    env: {
      PATH: `${dir}:/usr/bin:/bin`,
      YNM_STORE: join(dir, "store.git"),
      YNM_HOME: join(dir, "home"),
      ...env,
    },
    encoding: "utf8",
  });
  let calls = "";
  try {
    calls = readFileSync(log, "utf8");
  } catch {
    // nothing ran
  }
  return { status: r.status, stderr: r.stderr, calls };
}

describe("docker entrypoint never starts open by accident (ADR-017)", () => {
  it("refuses with no auth variable on the image's 0.0.0.0 bind, before touching the store or git", () => {
    const r = run({ YNM_GIT_DAEMON: "1", YNM_GIT_DAEMON_PUSH: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--no-auth/);
    expect(r.calls).toBe("");
  });

  it("starts the server when an auth variable is set, and starts no git daemon unasked", () => {
    const r = run({ YNM_MCP_TOKEN: "t" });
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/ynm serve --http .*--host 0\.0\.0\.0/);
    expect(r.calls).not.toMatch(/git daemon/);
  });

  it("starts with --no-auth, which is passed on to the server", () => {
    const r = run({}, ["--no-auth"]);
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/ynm serve --http .*--no-auth/);
  });

  it("starts with no auth when bound to loopback", () => {
    expect(run({ YNM_HTTP_HOST: "127.0.0.1" }).status).toBe(0);
  });

  it("serves git:// read-only: receive-pack is off unless YNM_GIT_DAEMON_PUSH=1", () => {
    const ro = run({ YNM_MCP_TOKEN: "t", YNM_GIT_DAEMON: "1" });
    expect(ro.calls).toMatch(/git daemon .*--disable=receive-pack/);
    expect(ro.calls).not.toMatch(/--enable=receive-pack/);
    const rw = run({ YNM_MCP_TOKEN: "t", YNM_GIT_DAEMON: "1", YNM_GIT_DAEMON_PUSH: "1" });
    expect(rw.calls).toMatch(/git daemon .*--enable=receive-pack/);
    expect(rw.stderr).toMatch(/unauthenticated pushes/);
  });
});
