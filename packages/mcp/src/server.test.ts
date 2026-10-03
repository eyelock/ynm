import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { initProject } from "@ynm/service";
import { createBare, createRepo, fx } from "@ynm/store/testing/git";
import {
  createYnmServer,
  MCP_TOOLS,
  parseArgs,
  serverInstructions,
  serviceCache,
} from "./index.js";

async function connected(cwd: string, home = mkdtempSync(join(tmpdir(), "ynm-mcp-home-"))) {
  const env = {
    ...process.env,
    YNM_HOME: join(home, ".ynm"),
    YNM_USER: "proto",
    YNM_NO_CLAUDE_CLI: "1",
  };
  const opts = { cwd, env };
  const server = createYnmServer(opts, serviceCache(opts));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function data<T>(r: { structuredContent?: unknown; content: unknown; isError?: boolean }): T {
  if (r.isError) throw new Error(JSON.stringify(r.content));
  return (r.structuredContent as { data: T }).data;
}

describe("ynm MCP server over JSON-RPC (ADR-008)", () => {
  it("lists the eleven tools, three resources and three prompts", async () => {
    const { client, close } = await connected(await createRepo(1));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...MCP_TOOLS].sort());
    expect(tools.tools.find((t) => t.name === "memory_recall")?.annotations?.readOnlyHint).toBe(
      true
    );
    expect((await client.listResources()).resources.map((r) => r.uri).sort()).toEqual([
      "memory://context",
      "memory://status",
    ]);
    expect((await client.listResourceTemplates()).resourceTemplates[0]?.uriTemplate).toBe(
      "memory://{mount}/{memoryId}"
    );
    expect((await client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual([
      "memory-session-start",
      "memory-when-to-promote",
      "memory-when-to-remember",
    ]);
    expect(client.getInstructions()).toMatch(/memory_context/);
    await close();
  });

  it("exercises every tool through the protocol", async () => {
    const repo = await createRepo(1);
    await initProject({ cwd: repo, hooks: false });
    const { client, close } = await connected(repo);
    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args });

    const started = data<{ sessionId: string; namespace: string; context: { markdown: string } }>(
      await call("memory_session", { action: "start" })
    );
    expect(started.context.markdown).toMatch(/^## Memory/);

    const r1 = data<{ memoryId: string; mount: string }>(
      await call("memory_remember", {
        type: "semantic",
        content: "Notes anchor to the root commit",
        tags: ["git"],
      })
    );
    expect(r1.mount).toBe("personal");
    const r2 = data<{ mount: string }>(
      await call("memory_remember", {
        type: "procedural",
        level: "distributed",
        content: "Run pnpm check before pushing",
      })
    );
    expect(r2.mount).toBe("project");
    const dup = await call("memory_remember", {
      type: "semantic",
      content: "Notes are anchored to the root commit",
    });
    expect((dup.structuredContent as { guidance: string | null }).guidance).toMatch(/similar/);
    await call("memory_remember", {
      type: "working",
      namespace: started.namespace,
      content: "scratch",
      ttl: "PT1S",
    });

    const hits = data<Array<{ memoryId: string; content: string }>>(
      await call("memory_recall", { text: "root commit anchor", explain: true })
    );
    expect(hits[0]?.content).toMatch(/root commit/);
    expect(
      data<{ markdown: string }>(await call("memory_context", { budgetTokens: 500 })).markdown
    ).toMatch(/pnpm check|root commit/);

    await call("memory_supersede", {
      memoryId: r1.memoryId,
      content: "Notes anchor to the oldest root commit",
    });
    await call("memory_annotate", { memoryId: r1.memoryId, pinned: true, importance: 0.9 });
    expect(
      data<Array<{ memoryId: string }>>(await call("memory_recall", { pinnedOnly: true }))[0]
        ?.memoryId
    ).toBe(r1.memoryId);
    await call("memory_forget", { memoryId: r1.memoryId, reason: "test" });
    expect(data<unknown[]>(await call("memory_recall", { text: "oldest" }))).toEqual([]);

    const dream = data<{ passes: { expire: { candidates: number; changed: string[] } } }>(
      await call("memory_consolidate", { dryRun: true })
    );
    expect(dream.passes.expire.candidates).toBe(1);
    await new Promise((r) => setTimeout(r, 1100));
    const ended = data<{ expired: string[] }>(
      await call("memory_session", { action: "end", sessionId: started.sessionId })
    );
    expect(ended.expired).toHaveLength(1);

    const sync = data<Record<string, { conflicts: string[] }>>(await call("memory_sync", {}));
    expect(sync.project?.conflicts[0]).toMatch(/remote "origin" is not configured/);
    const status = data<{ mounts: unknown[]; index: unknown[] }>(await call("memory_status", {}));
    expect(status.mounts).toHaveLength(2);

    const bad = await call("memory_remember", {
      type: "semantic",
      level: "distributed",
      content: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234",
    });
    expect(bad.isError).toBe(true);
    const invalid = await call("memory_remember", { type: "nope", content: "x" });
    expect(invalid.isError).toBe(true);

    const res = await client.readResource({ uri: "memory://status" });
    expect(JSON.parse((res.contents[0] as { text: string }).text).mounts).toHaveLength(2);
    const ctx = await client.readResource({ uri: "memory://context" });
    expect((ctx.contents[0] as { text: string }).text).toMatch(/^## Memory/);
    const distributed = data<Array<{ memoryId: string }>>(
      await call("memory_recall", { level: ["distributed"] })
    );
    const one = await client.readResource({
      uri: `memory://project/${distributed[0]?.memoryId ?? ""}`,
    });
    expect(JSON.parse((one.contents[0] as { text: string }).text).mount).toBe("project");
    const prompt = await client.getPrompt({ name: "memory-when-to-remember", arguments: {} });
    const first = prompt.messages[0]?.content as { text?: string } | undefined;
    expect(first?.text).toMatch(/^# When to remember/);
    await close();
  }, 60_000);

  it("serves a bare repo with no work tree (ADR-009)", async () => {
    const bare = await createBare();
    await initProject({ cwd: bare, hooks: false });
    const { client, close } = await connected(bare);
    const r = data<{ mount: string }>(
      await client.callTool({
        name: "memory_remember",
        arguments: { type: "semantic", level: "distributed", content: "hosted fact" },
      })
    );
    expect(r.mount).toBe("project");
    expect(await fx(bare, "for-each-ref", "--format=%(refname)", "refs/notes/")).toMatch(
      /ynm\/distributed/
    );
    await close();
  });

  it("reads wiki pages and refuses unknown memories, wrong mounts and missing pages", async () => {
    const repo = await createRepo(1);
    await initProject({ cwd: repo, hooks: false });
    const { client, close } = await connected(repo);
    const r = data<{ memoryId: string; mount: string }>(
      await client.callTool({
        name: "memory_remember",
        arguments: { type: "semantic", level: "distributed", content: "Wiki pages project memory" },
      })
    );
    expect(r.mount).toBe("project");

    const index = await client.readResource({ uri: "memory://project/wiki/index.md" });
    expect(index.contents[0]?.mimeType).toBe("text/markdown");
    expect((index.contents[0] as { text: string }).text).toContain(r.memoryId);
    const page = await client.readResource({
      uri: `memory://project/wiki/memories/${r.memoryId}.md`,
    });
    expect((page.contents[0] as { text: string }).text).toMatch(/Wiki pages project memory/);

    await expect(client.readResource({ uri: "memory://project/wiki/nope.md" })).rejects.toThrow(
      /no wiki page nope\.md in mount project/
    );
    await expect(client.readResource({ uri: `memory://personal/${r.memoryId}` })).rejects.toThrow(
      new RegExp(`no memory ${r.memoryId} in mount personal`)
    );
    await expect(client.readResource({ uri: "memory://project/01NOSUCHMEMORY" })).rejects.toThrow(
      /no memory 01NOSUCHMEMORY/
    );
    await close();
  });

  it("builds the instructions from the levels it serves and claims remember intents", async () => {
    const hosted = serverInstructions(["distributed"]);
    expect(hosted).toMatch(/instead of any built-in memory, memory directory or notes file/);
    expect(hosted).toMatch(/"call me".*memory_remember/);
    expect(hosted).toMatch(/memory_recall/);
    expect(hosted).toMatch(/distributed only/);
    expect(hosted).not.toMatch(/personal by default/);
    expect(serverInstructions(["personal", "distributed"])).toMatch(/personal by default/);
    expect(serverInstructions(["personal"])).toMatch(/no distributed store is open/);
    expect(serverInstructions([])).toMatch(/No store is open yet/);
    expect(hosted).not.toMatch(/ADR|\bM\d\b/);

    const server = createYnmServer({ cwd: "/nowhere", noPersonal: true }, async () => {
      throw new Error("unused");
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientT);
    expect(client.getInstructions()).toBe(hosted);
    const remember = (await client.listTools()).tools.find((t) => t.name === "memory_remember");
    expect(remember?.description).toMatch(/instead of any built-in memory/);
    await client.close();
    await server.close();
  });

  it("remembers without a level on a server with no personal mount", async () => {
    const bare = await createBare();
    await initProject({ cwd: bare, hooks: false });
    const home = mkdtempSync(join(tmpdir(), "ynm-mcp-home-"));
    const opts = {
      cwd: bare,
      noPersonal: true,
      env: {
        ...process.env,
        YNM_HOME: join(home, ".ynm"),
        YNM_USER: "proto",
        YNM_NO_CLAUDE_CLI: "1",
      },
    };
    const server = createYnmServer(opts, serviceCache(opts));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientT);
    const r = data<{ mount: string }>(
      await client.callTool({
        name: "memory_remember",
        arguments: { type: "semantic", content: "Call the user DC." },
      })
    );
    expect(r.mount).toBe("project");
    await client.close();
    await server.close();
  });

  it("turns a failure to open the service into a tool error, not a protocol error", async () => {
    const server = createYnmServer({ cwd: "/nowhere", version: "9.9.9" }, async () => {
      throw "store unavailable";
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientT);
    expect(client.getServerVersion()?.version).toBe("9.9.9");
    const r = await client.callTool({ name: "memory_status" });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: "text", text: "store unavailable" }]);
    await client.close();
    await server.close();
  });

  it("parses CLI arguments", () => {
    expect(parseArgs(["--http", "--port", "4000", "--token", "t", "--cwd", "/x"])).toMatchObject({
      mode: "http",
      port: 4000,
      token: "t",
      cwd: "/x",
    });
    expect(parseArgs([]).mode).toBe("stdio");
  });
});
