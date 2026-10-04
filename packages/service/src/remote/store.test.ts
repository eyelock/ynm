import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { OCCURRENCE_TAG } from "@ynm/model";
import { MemoryLog } from "@ynm/store";
import { DEFAULT_REDACTION } from "../config.js";
import { IndexManager } from "../indexing.js";
import { openYnm } from "../open.js";
import { TOOL_SPECS, type ToolSpec, toolSpec } from "../tools.js";
import { Ynm } from "../ynm.js";
import { RemoteStore, RemoteToolError, RemoteUnavailableError } from "./store.js";

/** A hosted ynm in process: one distributed store and its tools over MCP. */
function hostedYnm(): Ynm {
  return new Ynm({
    mounts: [
      {
        id: "project",
        level: "distributed",
        location: "mem",
        log: new MemoryLog("t", "distributed"),
      },
    ],
    actor: "user:server",
    userId: "server",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
  });
}

function serve(ynm: Ynm): McpServer {
  const server = new McpServer({ name: "ynm", version: "0" }, { capabilities: { tools: {} } });
  for (const spec of TOOL_SPECS as readonly ToolSpec[])
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: spec.input },
      async (args) => {
        try {
          const r = await spec.run(ynm, spec.input.parse(args ?? {}));
          return {
            content: [{ type: "text", text: JSON.stringify(r.data) }],
            structuredContent: { data: r.data },
          };
        } catch (err) {
          return { content: [{ type: "text", text: (err as Error).message }], isError: true };
        }
      }
    );
  return server;
}

function remote(
  hosted: Ynm,
  over: Partial<ConstructorParameters<typeof RemoteStore>[0]> = {}
): RemoteStore {
  return new RemoteStore({
    id: "team",
    url: "http://hosted.test/mcp",
    transport: async () => {
      const [client, server] = InMemoryTransport.createLinkedPair();
      await serve(hosted).connect(server);
      return client;
    },
    ...over,
  });
}

function local(r: RemoteStore): Ynm {
  return new Ynm({
    mounts: [
      { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
    ],
    remotes: [r],
    actor: "user:david",
    userId: "david",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
  });
}

const unreachable = () =>
  remote(hostedYnm(), {
    transport: () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9");
    },
  });

describe("remote mounts in the service (ADR-004)", () => {
  it("keeps unnamed memories personal and shares on request, then recalls both in one list", async () => {
    const hosted = hostedYnm();
    const y = local(remote(hosted));
    const mine = await y.remember({
      type: "semantic",
      content: "I deploy dashboards in dark mode",
    });
    const shared = await y.remember({
      type: "semantic",
      level: "distributed",
      namespace: "common",
      content: "We deploy on Thursdays",
    });
    expect([mine.mount, shared.mount]).toEqual(["personal", "team"]);
    expect((await hosted.find(shared.memoryId))?.current.content).toMatch(/Thursdays/);
    const hits = await y.recall({ text: "deploy" });
    expect(new Set(hits.map((h) => h.mount))).toEqual(new Set(["personal", "team"]));
    expect(hits[0]?.score).toBeLessThan(1); // fused by rank, not the rankers' own scores
    expect(
      (await y.recall({ text: "deploy", mount: "personal" })).every((h) => h.mount === "personal")
    ).toBe(true);
    expect(
      (await y.recall({ text: "deploy", mount: "team" })).every((h) => h.mount === "team")
    ).toBe(true);
  });

  it("adds a shared section to the context block, within its share of the budget", async () => {
    const hosted = hostedYnm();
    const y = local(remote(hosted));
    await y.remember({ type: "semantic", content: "I review PRs as drafts" });
    await y.remember({
      type: "semantic",
      level: "distributed",
      namespace: "common",
      content: "Releases come from develop",
    });
    const block = await y.context({ budgetTokens: 400 });
    expect(block.markdown).toMatch(/^## Memory\n- \(semantic\) I review PRs as drafts/);
    expect(block.markdown).toMatch(
      /## Shared memory \(team\)\n- \(semantic\) Releases come from develop/
    );
    expect(block.included).toHaveLength(2);
    expect(block.tokens).toBeLessThanOrEqual(400);
    // An empty shared store adds nothing.
    const empty = local(remote(hostedYnm()));
    expect(await empty.context({})).toMatchObject({ markdown: "", included: [], tokens: 0 });
    // With no personal memory, the block is the shared section alone, not a bare heading.
    const sharedOnly = local(remote(hosted));
    expect((await sharedOnly.context({})).markdown).toMatch(/^## Shared memory \(team\)\n/);
    const spec = toolSpec("memory_context");
    if (!spec) throw new Error("missing memory_context");
    const tool = await spec.run(sharedOnly, { budgetTokens: 1500 } as never);
    expect((tool.data as { markdown: string }).markdown).toMatch(/^## Shared memory \(team\)\n/);
    expect(tool.guidance).toBeUndefined();
  });

  it("leaves occurrences out of the context block, personal and shared, but recalls them", async () => {
    const hosted = hostedYnm();
    const y = local(remote(hosted));
    await y.remember({ type: "semantic", content: "I review PRs as drafts" });
    const mine = await y.remember({
      type: "episodic",
      subject: "sig/flaky",
      content: "Flaky test failed on my run",
      tags: [OCCURRENCE_TAG],
    });
    await y.pin(mine.memoryId); // a pinned occurrence stays out too
    await y.remember({
      type: "semantic",
      level: "distributed",
      namespace: "common",
      content: "Releases come from develop",
    });
    const shared = await y.remember({
      type: "episodic",
      level: "distributed",
      namespace: "common",
      subject: "sig/flaky",
      content: "Flaky test failed on the team run",
      tags: [OCCURRENCE_TAG],
    });
    const block = await y.context({ budgetTokens: 1000 });
    expect(block.markdown).toMatch(/I review PRs as drafts/);
    expect(block.markdown).toMatch(/Releases come from develop/);
    expect(block.markdown).not.toMatch(/Flaky/);
    expect(block.included).toHaveLength(2);
    // The hosted store packs its own section without them too.
    expect((await hosted.context({})).markdown).not.toMatch(/Flaky/);
    const hits = await y.recall({ text: "flaky test failed" });
    expect(hits.map((h) => h.memoryId).sort()).toEqual([mine.memoryId, shared.memoryId].sort());
    expect((await y.list({ tags: [OCCURRENCE_TAG] })).length).toBe(2);
  });

  it("edits a shared memory where it lives and promotes a personal one by copy", async () => {
    const hosted = hostedYnm();
    const y = local(remote(hosted));
    const shared = await y.remember({
      type: "semantic",
      level: "distributed",
      namespace: "common",
      content: "Staging is staging.example.com",
    });
    expect(
      (await y.supersede({ memoryId: shared.memoryId, content: "Staging is stage.example.com" }))
        .mount
    ).toBe("team");
    expect((await y.annotate({ memoryId: shared.memoryId, tags: ["env"] })).mount).toBe("team");
    expect((await hosted.find(shared.memoryId))?.tags).toContain("env");
    expect((await y.forget({ memoryId: shared.memoryId, reason: "moved" })).mount).toBe("team");
    expect((await hosted.find(shared.memoryId))?.tombstoned).toBe(true);
    await expect(
      y.annotate({ memoryId: "01M40000000000000000000000", tags: ["x"] })
    ).rejects.toThrow(/unknown memory/);

    const personal = await y.remember({
      type: "procedural",
      content: "Run the gate before tagging",
      subject: "release",
    });
    const promoted = await y.promote(personal.memoryId);
    expect(promoted.mount).toBe("team");
    const copy = await hosted.find(promoted.memoryId);
    expect(copy).toMatchObject({ subject: "release", namespace: "common" });
    expect(copy?.current.provenance.source).toBe("promoted:personal");
    expect((await y.find(personal.memoryId))?.level).toBe("personal");
  });

  it("refuses a secret before it leaves the machine", async () => {
    const hosted = hostedYnm();
    const y = local(remote(hosted));
    await expect(
      y.remember({
        type: "semantic",
        level: "distributed",
        content: "token ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      })
    ).rejects.toThrow();
    expect(await hosted.list()).toEqual([]);
  });

  it("lists the remote in status, with its shards or why it could not be asked", async () => {
    const hosted = hostedYnm();
    const y = local(remote(hosted));
    await y.remember({ type: "semantic", level: "distributed", content: "x marks the spot" });
    expect((await y.status()).mounts.find((m) => m.id === "team")).toMatchObject({
      provider: "mcp",
      shards: 1,
    });
    const off = (await local(unreachable()).status()).mounts.find((m) => m.id === "team");
    expect(off).toMatchObject({ shards: -1 });
    expect(off?.error).toMatch(/ECONNREFUSED/);
  });

  it("goes on without a remote it cannot reach, and the tools say so", async () => {
    const y = local(unreachable());
    await y.remember({ type: "semantic", content: "Offline note" });
    const r = await toolSpec("memory_recall")?.run(y, { text: "offline", limit: 10 } as never);
    expect(r?.guidance).toMatch(/Shared memory left out: team: connect ECONNREFUSED/);
    const none = await toolSpec("memory_recall")?.run(y, {
      text: "nothing like this",
      limit: 10,
    } as never);
    expect(none?.guidance).toMatch(/^No matches\..*Shared memory left out/);
    const c = await toolSpec("memory_context")?.run(y, { budgetTokens: 500 } as never);
    expect(c?.guidance).toMatch(/Shared memory left out/);
    await expect(
      y.remember({ type: "semantic", level: "distributed", content: "x" })
    ).rejects.toThrow(RemoteUnavailableError);
  });

  it("names a missing sign-in, times out a slow remote, and reconnects after a failure", async () => {
    const signIn = remote(hostedYnm(), {
      transport: () => {
        throw new Error("not signed in to team: run `ynm login team`");
      },
    });
    await expect(signIn.call("memory_status", {})).rejects.toThrow(
      /^team: not signed in: run `ynm login team`$/
    );
    const slow = remote(hostedYnm(), { transport: () => new Promise(() => {}), timeoutMs: 50 });
    await expect(slow.call("memory_status", {})).rejects.toThrow(/no answer within 50 ms/);
    let attempts = 0;
    const hosted = hostedYnm();
    const flaky = remote(hosted, {
      transport: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("connection reset");
        const [client, server] = InMemoryTransport.createLinkedPair();
        await serve(hosted).connect(server);
        return client;
      },
    });
    await expect(flaky.call("memory_status", {})).rejects.toThrow(/connection reset/);
    expect(await flaky.call("memory_status", {})).toMatchObject({ mounts: [{ id: "project" }] });
    await expect(
      flaky.call("memory_forget", { memoryId: "01M40000000000000000000000" })
    ).rejects.toThrow(RemoteToolError);
    await flaky.close();
    await new RemoteStore({ id: "never", url: "http://x.test/mcp" }).close();
  });

  it("opens remote mounts from config, signed in from the credentials file only", async () => {
    const home = mkdtempSync(join(tmpdir(), "ynm-remote-open-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        mounts: [
          { id: "team", level: "distributed", provider: "mcp", url: "http://127.0.0.1:9/mcp" },
        ],
      })
    );
    const { ynm, remotes, mounts } = await openYnm({
      cwd: home,
      env: { ...process.env, YNM_HOME: home, YNM_USER: "david", YNM_NO_CLAUDE_CLI: "1" },
    });
    expect(remotes.map((r) => [r.id, r.url])).toEqual([["team", "http://127.0.0.1:9/mcp"]]);
    expect(mounts.some((m) => m.id === "team")).toBe(false);
    expect(ynm.remotes).toHaveLength(1);
  });
});
