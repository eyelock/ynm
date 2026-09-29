import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "@ynm/store/testing/git";
import { docker, dockerAvailable, hostPort, waitFor } from "./docker.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");
const cli = join(repoRoot, "packages", "cli", "bin", "run.js");
const available = dockerAvailable();
const USER = "ynm";
const PASS = "ynm-pass-123";

/**
 * NFR-6: a dedicated shared memory repo on a forge. Gitea in a container plays the forge; two
 * clones init, write, sync (fetch, cat_sort_uniq merge, push) and see each other's memories.
 */
describe.skipIf(!available)("shared store on a Gitea container (NFR-6)", () => {
  let container = "";
  let port = 0;

  beforeAll(async () => {
    container = docker(
      "run",
      "-d",
      "--rm",
      "-p",
      "127.0.0.1:0:3000",
      "-e",
      "GITEA__security__INSTALL_LOCK=true",
      "-e",
      "GITEA__server__ROOT_URL=http://127.0.0.1:3000/",
      "-e",
      "GITEA__service__DISABLE_REGISTRATION=true",
      "gitea/gitea:1.22"
    );
    port = hostPort(container, 3000);
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${port}/api/healthz`)).ok,
      120_000,
      "gitea"
    );
    docker(
      "exec",
      "-u",
      "git",
      container,
      "gitea",
      "admin",
      "user",
      "create",
      "--username",
      USER,
      "--password",
      PASS,
      "--email",
      "ynm@example.com",
      "--admin",
      "--must-change-password=false"
    );
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/user/repos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`,
      },
      body: JSON.stringify({ name: "memory", auto_init: false, private: true }),
    });
    expect(res.status).toBe(201);
  }, 300_000);

  afterAll(() => {
    if (container) spawnSync("docker", ["stop", "-t", "2", container]);
  });

  it("two clones sync shared memory through the forge", async () => {
    const remote = `http://${USER}:${PASS}@127.0.0.1:${port}/${USER}/memory.git`;
    const env = (user: string) => ({
      ...process.env,
      YNM_HOME: join(mkdtempSync(join(tmpdir(), `ynm-gitea-${user}-`)), ".ynm"),
      YNM_USER: user,
      YNM_NO_CLAUDE_CLI: "1",
    });
    const run = (cwd: string, e: NodeJS.ProcessEnv, cmd: string, args: string[]) => {
      const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: e });
      expect(r.status, `${cmd} ${args.join(" ")}\n${r.stdout}${r.stderr}`).toBe(0);
      return r.stdout;
    };
    const one = await createRepo(1);
    const e1 = env("one");
    run(one, e1, "git", ["remote", "add", "origin", remote]);
    run(one, e1, "git", ["push", "-q", "-u", "origin", "main"]);
    run(one, e1, "node", [cli, "init", "--no-hooks"]);
    run(one, e1, "node", [
      cli,
      "remember",
      "--type",
      "procedural",
      "--level",
      "distributed",
      "--content",
      "forge-hosted: release gate before tagging",
    ]);
    run(one, e1, "node", [cli, "sync", "--json"]);

    const two = mkdtempSync(join(tmpdir(), "ynm-gitea-two-"));
    const e2 = env("two");
    run(two, e2, "git", ["clone", "-q", remote, "."]);
    run(two, e2, "node", [cli, "init", "--no-hooks"]);
    run(two, e2, "node", [cli, "sync", "--json"]);
    expect(run(two, e2, "node", [cli, "list", "--json", "--level", "distributed"])).toContain(
      "forge-hosted"
    );

    // concurrent writes to the same shard from both clones merge (cat_sort_uniq), nothing lost
    run(one, e1, "node", [
      cli,
      "remember",
      "--type",
      "procedural",
      "--level",
      "distributed",
      "--content",
      "from clone one",
    ]);
    run(two, e2, "node", [
      cli,
      "remember",
      "--type",
      "procedural",
      "--level",
      "distributed",
      "--content",
      "from clone two",
    ]);
    run(one, e1, "node", [cli, "sync", "--json"]);
    run(two, e2, "node", [cli, "sync", "--json"]);
    run(one, e1, "node", [cli, "sync", "--json"]);
    for (const [cwd, e] of [
      [one, e1],
      [two, e2],
    ] as const) {
      const out = run(cwd, e, "node", [cli, "list", "--json", "--level", "distributed"]);
      expect(out).toContain("from clone one");
      expect(out).toContain("from clone two");
      expect(out).toContain("forge-hosted");
    }
  }, 300_000);
});
