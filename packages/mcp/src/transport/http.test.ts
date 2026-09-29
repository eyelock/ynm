import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { initProject } from "@ynm/service";
import { createBare } from "@ynm/store/testing/git";
import { createYnmServer, serviceCache } from "../server.js";
import { startHttp } from "./http.js";

async function hosted(token?: string) {
  const bare = await createBare();
  await initProject({ cwd: bare, hooks: false });
  const home = mkdtempSync(join(tmpdir(), "ynm-http-home-"));
  const opts = {
    cwd: bare,
    env: { ...process.env, YNM_HOME: join(home, ".ynm"), YNM_USER: "http" },
    noPersonal: true,
  };
  const getYnm = serviceCache(opts);
  const handle = await startHttp(() => createYnmServer(opts, getYnm), {
    port: 0,
    authToken: token,
    quiet: true,
  });
  return { handle, bare };
}

async function connect(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: "http-test", version: "0" });
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

describe("Streamable HTTP transport (ADR-009, NFR-11)", () => {
  it("serves health, rejects a missing bearer, and answers tool calls", async () => {
    const { handle } = await hosted("secret");
    const health = await fetch(`http://localhost:${handle.port}/health`);
    expect((await health.json()).status).toBe("ok");
    const unauth = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unauth.status).toBe(401);
    const client = await connect(handle.url, "secret");
    expect((await client.listTools()).tools).toHaveLength(10);
    const r = data<{ mount: string }>(
      await client.callTool({
        name: "memory_remember",
        arguments: { type: "semantic", level: "distributed", content: "hosted fact" },
      })
    );
    expect(r.mount).toBe("project");
    await client.close();
    await handle.close();
  }, 30_000);

  it("two interleaved clients share the store but no per-request state", async () => {
    const { handle } = await hosted();
    const a = await connect(handle.url);
    const b = await connect(handle.url);
    const call = (c: Client, name: string, args: Record<string, unknown>) =>
      c.callTool({ name, arguments: args });
    const [sa, sb] = await Promise.all([
      call(a, "memory_session", { action: "start", sessionId: "session-a" }),
      call(b, "memory_session", { action: "start", sessionId: "session-b" }),
    ]);
    expect(data<{ sessionId: string }>(sa).sessionId).toBe("session-a");
    expect(data<{ sessionId: string }>(sb).sessionId).toBe("session-b");
    const writes = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call(i % 2 ? a : b, "memory_remember", {
          type: "semantic",
          level: "distributed",
          content: `fact ${i} from ${i % 2 ? "a" : "b"}`,
        })
      )
    );
    expect(writes.every((w) => !w.isError)).toBe(true);
    const [ra, rb] = await Promise.all([
      call(a, "memory_recall", { text: "fact", limit: 20 }),
      call(b, "memory_recall", { text: "fact", limit: 20 }),
    ]);
    expect(data<unknown[]>(ra)).toHaveLength(6);
    expect(data<unknown[]>(rb)).toHaveLength(6);
    const [ea, eb] = await Promise.all([
      call(a, "memory_session", { action: "end", sessionId: "session-a" }),
      call(b, "memory_session", { action: "end", sessionId: "session-b" }),
    ]);
    expect(data<{ sessionId: string }>(ea).sessionId).toBe("session-a");
    expect(data<{ sessionId: string }>(eb).sessionId).toBe("session-b");
    await a.close();
    await b.close();
    await handle.close();
  }, 30_000);
});
