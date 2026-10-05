import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { docker, dockerAvailable, hostPort, waitFor } from "./docker.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");
const cli = join(repoRoot, "packages", "cli", "bin", "run.js");
const available = dockerAvailable();
const IMAGE = "ynm:test";

async function connect(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: "docker-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(url),
      token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined
    )
  );
  return client;
}

function data<T>(r: { structuredContent?: unknown; isError?: boolean; content: unknown }): T {
  if (r.isError) throw new Error(JSON.stringify(r.content));
  return (r.structuredContent as { data: T }).data;
}

/**
 * The hosted topology end to end (ADR-009): the Docker image serves a bare repo over HTTP with a
 * bearer, two agents without git share it, the dream worker runs on its timer, and a local clone
 * uses the container as its git remote to sync distributed notes both ways.
 */
describe.skipIf(!available)("hosted service in Docker (ADR-009)", () => {
  let container = "";
  let mcpPort = 0;
  let gitPort = 0;

  beforeAll(() => {
    // The install reads @eyelock/otel-spool-exporter with NODE_AUTH_TOKEN, passed as a secret.
    docker(
      "build",
      "-q",
      "--secret",
      "id=node_auth_token,env=NODE_AUTH_TOKEN",
      "-t",
      IMAGE,
      repoRoot
    );
    container = docker(
      "run",
      "-d",
      "--rm",
      "-p",
      "127.0.0.1:0:3000",
      "-p",
      "127.0.0.1:0:9418",
      "-e",
      "YNM_MCP_TOKEN=secret",
      "-e",
      "YNM_GIT_DAEMON=1",
      "-e",
      "YNM_DREAM_EVERY=2s",
      IMAGE
    );
    mcpPort = hostPort(container, 3000);
    gitPort = hostPort(container, 9418);
  }, 900_000);

  afterAll(() => {
    if (container) spawnSync("docker", ["stop", "-t", "2", container]);
  });

  it("auth, two clients, dream worker, local clone sync", async () => {
    const health = `http://127.0.0.1:${mcpPort}/health`;
    const url = `http://127.0.0.1:${mcpPort}/mcp`;
    await waitFor(async () => (await fetch(health)).ok, 60_000, "container health");
    const h = (await (await fetch(health)).json()) as {
      auth: string;
      scheduler: { dreamRuns: number };
    };
    expect(h.auth).toBe("bearer");

    // auth: no token and a wrong token are refused with a challenge; the right one is accepted
    const anon = await fetch(url, { method: "POST", body: "{}" });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(
      (await fetch(url, { method: "POST", headers: { Authorization: "Bearer wrong" }, body: "{}" }))
        .status
    ).toBe(401);

    // two agents with no git share the store
    const a = await connect(url, "secret");
    const b = await connect(url, "secret");
    const w = data<{ memoryId: string; mount: string }>(
      await a.callTool({
        name: "memory_remember",
        arguments: {
          type: "semantic",
          level: "distributed",
          content: "the hosted store is the single writer",
          tags: ["hosting"],
        },
      })
    );
    expect(w.mount).toBe("project");
    const scratch = await a.callTool({
      name: "memory_remember",
      arguments: {
        type: "working",
        level: "distributed",
        namespace: "session/docker-test",
        content: "scratch that expires",
        ttl: "PT1S",
      },
    });
    expect(scratch.isError, JSON.stringify(scratch.content)).toBeFalsy();
    const seen = data<Array<{ memoryId: string }>>(
      await b.callTool({ name: "memory_recall", arguments: { text: "single writer hosted" } })
    );
    expect(seen.map((m) => m.memoryId)).toContain(w.memoryId);

    // the dream worker runs on its timer inside the container and expires the working memory
    await waitFor(
      async () =>
        ((await (await fetch(health)).json()) as { scheduler: { dreamRuns: number } }).scheduler
          .dreamRuns >= 2,
      30_000,
      "dream runs"
    );
    await waitFor(
      async () => {
        const left = data<Array<{ content: string }>>(
          await b.callTool({
            name: "memory_recall",
            arguments: { text: "scratch expires", type: ["working"] },
          })
        );
        return left.length === 0;
      },
      30_000,
      "expiry by the dream worker"
    );

    // consolidation runs over HTTP too: the hosted process owns the dream passes (ADR-006)
    const dreamed = data<{ passes: Record<string, { candidates: number }> }>(
      await a.callTool({ name: "memory_consolidate", arguments: { dryRun: true } })
    );
    expect(Object.keys(dreamed.passes)).toContain("expire");

    // a local clone: the container is its git remote; distributed notes sync both ways
    const work = mkdtempSync(join(tmpdir(), "ynm-docker-clone-"));
    const home = join(mkdtempSync(join(tmpdir(), "ynm-docker-home-")), ".ynm");
    const env = { ...process.env, YNM_HOME: home, YNM_USER: "clone", YNM_NO_CLAUDE_CLI: "1" };
    const sh = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: work, encoding: "utf8", env });
    expect(sh("git", ["clone", "-q", `git://127.0.0.1:${gitPort}/store.git`, "."]).status).toBe(0);
    expect(sh("node", [cli, "init", "--no-hooks"]).status).toBe(0);
    const sync1 = sh("node", [cli, "sync", "--json"]);
    expect(sync1.status, sync1.stderr).toBe(0);
    const list = sh("node", [cli, "list", "--json", "--level", "distributed"]);
    expect(list.stdout).toContain("the hosted store is the single writer");
    const back = sh("node", [
      cli,
      "remember",
      "--type",
      "semantic",
      "--level",
      "distributed",
      "--content",
      "written in the clone, pushed to the host",
      "--json",
    ]);
    expect(back.status, back.stderr).toBe(0);
    expect(sh("node", [cli, "sync", "--json"]).status).toBe(0);
    await waitFor(
      async () => {
        const hits = data<Array<{ content: string }>>(
          await a.callTool({
            name: "memory_recall",
            arguments: { text: "written clone pushed host" },
          })
        );
        return hits.some((m) => m.content.includes("written in the clone"));
      },
      20_000,
      "hosted index to see the pushed shard"
    );
    await a.close();
    await b.close();
  }, 180_000);
});
