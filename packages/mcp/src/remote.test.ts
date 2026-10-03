import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REDACTION, IndexManager, RemoteStore, toolSpec, Ynm } from "@ynm/service";
import { MemoryLog } from "@ynm/store";
import { StaticTokenVerifier } from "./auth.js";
import { createYnmServer, serviceCache } from "./server.js";
import { type HttpHandle, startHttp } from "./transport/http.js";

/** A hosted ynm: one shared sqlite store behind a token, as the team's server would be. */
async function hostedStore(): Promise<{ handle: HttpHandle; getYnm: () => Promise<Ynm> }> {
  const home = join(mkdtempSync(join(tmpdir(), "ynm-remote-home-")), ".ynm");
  mkdirSync(home, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "ynm-remote-store-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      mounts: [
        { id: "project", level: "distributed", provider: "sqlite", path: join(dir, "s.sqlite") },
      ],
    })
  );
  const opts = {
    cwd: dir,
    env: { ...process.env, YNM_HOME: home, YNM_USER: "server", YNM_NO_CLAUDE_CLI: "1" },
    noPersonal: true,
  };
  const getYnm = serviceCache(opts);
  const handle = await startHttp(() => createYnmServer(opts, getYnm), {
    port: 0,
    host: "127.0.0.1",
    quiet: true,
    verifier: new StaticTokenVerifier(["team-token"], ["memory:read", "memory:write"]),
  });
  return { handle, getYnm };
}

/** A local ynm: a personal store here, and the hosted store mounted as `team`. */
function local(url: string, token = "team-token"): Ynm {
  return new Ynm({
    mounts: [
      { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
    ],
    remotes: [
      new RemoteStore({
        id: "team",
        url,
        authProvider: { token: async () => token },
        timeoutMs: 5000,
      }),
    ],
    actor: "user:david",
    userId: "david",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
  });
}

function run(y: Ynm, name: string, input: Record<string, unknown>) {
  const s = toolSpec(name);
  if (!s) throw new Error(`missing ${name}`);
  return s.run(y, s.input.parse(input));
}

describe("a remote mount: a hosted ynm over MCP (ADR-004, ADR-017)", () => {
  let hosted: Awaited<ReturnType<typeof hostedStore>>;
  beforeAll(async () => {
    hosted = await hostedStore();
  });
  afterAll(async () => {
    await hosted.handle.close();
  });

  it("keeps unnamed memories personal and sends a shared one to the hosted store", async () => {
    const y = local(hosted.handle.url);
    const mine = await y.remember({ type: "semantic", content: "I prefer squash merges" });
    expect(mine.mount).toBe("personal");
    const shared = await y.remember({
      type: "semantic",
      level: "distributed",
      content: "Deploys go out on Thursdays",
      namespace: "common",
    });
    expect(shared.mount).toBe("team");
    const server = await hosted.getYnm();
    expect((await server.find(shared.memoryId))?.current.content).toBe(
      "Deploys go out on Thursdays"
    );
    expect(await server.find(mine.memoryId)).toBeNull();
  });

  it("recalls from both stores in one ranked list, labelled by mount", async () => {
    const y = local(hosted.handle.url);
    await y.remember({ type: "semantic", content: "Personal: deploy dashboards in dark mode" });
    const hits = await y.recall({ text: "deploy" });
    const mounts = new Set(hits.map((h) => h.mount));
    expect(mounts).toEqual(new Set(["personal", "team"]));
    // Only the personal level: the hosted store is not asked.
    const personalOnly = await y.recall({ text: "deploy", level: ["personal"] });
    expect(personalOnly.every((h) => h.mount === "personal")).toBe(true);
  });

  it("builds one context block with a section for the shared store", async () => {
    const y = local(hosted.handle.url);
    await y.remember({ type: "semantic", content: "Personal: I review PRs as drafts" });
    const block = await y.context({ budgetTokens: 1500 });
    expect(block.markdown).toMatch(/^## Memory\n/);
    expect(block.markdown).toMatch(/## Shared memory \(team\)\n/);
    expect(block.markdown).toMatch(/Thursdays/);
  });

  it("edits and promotes through the hosted store", async () => {
    const y = local(hosted.handle.url);
    const shared = await y.remember({
      type: "semantic",
      level: "distributed",
      namespace: "common",
      content: "The staging URL is staging.example.com",
    });
    const edited = await y.supersede({
      memoryId: shared.memoryId,
      content: "The staging URL is stage.example.com",
    });
    expect(edited.mount).toBe("team");
    const server = await hosted.getYnm();
    expect((await server.find(shared.memoryId))?.current.content).toMatch(/stage\.example/);
    await expect(y.forget({ memoryId: "01M40000000000000000000000" })).rejects.toThrow(
      /unknown memory/
    );

    const personal = await y.remember({
      type: "procedural",
      content: "Run the release gate before tagging",
    });
    const promoted = await y.promote(personal.memoryId);
    expect(promoted.mount).toBe("team");
    const copy = await server.find(promoted.memoryId);
    expect(copy?.current.content).toBe("Run the release gate before tagging");
    expect(copy?.current.provenance.source).toBe("promoted:personal");
    // The original stays personal.
    expect((await y.find(personal.memoryId))?.level).toBe("personal");
  });

  it("reports the hosted store in status", async () => {
    const status = await local(hosted.handle.url).status();
    const team = status.mounts.find((m) => m.id === "team");
    expect(team).toMatchObject({
      provider: "mcp",
      level: "distributed",
      location: hosted.handle.url,
    });
    expect(team?.shards).toBeGreaterThan(0);
  });

  it("goes on without a store it cannot reach, and says so", async () => {
    const offline = local("http://127.0.0.1:9/mcp");
    await offline.remember({ type: "semantic", content: "Personal note while offline" });
    const r = await run(offline, "memory_recall", { text: "offline" });
    expect((r.data as Array<{ mount: string }>).every((h) => h.mount === "personal")).toBe(true);
    expect(r.guidance).toMatch(/Shared memory left out: team \(/);
    const c = await run(offline, "memory_context", {});
    expect((c.data as { markdown: string }).markdown).not.toMatch(/Shared memory/);
    expect((await offline.status()).mounts.find((m) => m.id === "team")?.shards).toBe(-1);
    await expect(
      offline.remember({ type: "semantic", level: "distributed", content: "x" })
    ).rejects.toThrow(/team:/);
  });

  it("refuses a bad credential as not signed in", async () => {
    const y = local(hosted.handle.url, "wrong");
    const r = await run(y, "memory_recall", { text: "deploy" });
    expect(r.guidance).toMatch(/team \(team: not signed in/);
  });
});
