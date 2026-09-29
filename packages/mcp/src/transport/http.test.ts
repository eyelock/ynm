import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { initProject } from "@ynm/service";
import { createBare } from "@ynm/store/testing/git";
import { StaticTokenVerifier } from "../auth.js";
import { createYnmServer, serviceCache } from "../server.js";
import { type HttpOptions, startHttp } from "./http.js";

type Provider = "git-notes" | "sqlite";

/**
 * A hosted server: no personal mount, one distributed store. With git-notes the store is a bare
 * repo initialised in place; with sqlite it is an explicit mount in the hosted home's config,
 * so the same suite runs unchanged on both providers (ADR-004).
 */
async function hosted(provider: Provider, http: Partial<HttpOptions> = {}) {
  const home = join(mkdtempSync(join(tmpdir(), "ynm-http-home-")), ".ynm");
  mkdirSync(home, { recursive: true });
  let cwd: string;
  if (provider === "git-notes") {
    cwd = await createBare();
    await initProject({ cwd, hooks: false });
  } else {
    cwd = mkdtempSync(join(tmpdir(), "ynm-http-sqlite-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        mounts: [
          {
            id: "project",
            level: "distributed",
            provider: "sqlite",
            path: join(cwd, "store.sqlite"),
          },
        ],
      })
    );
  }
  const opts = {
    cwd,
    env: { ...process.env, YNM_HOME: home, YNM_USER: "http", YNM_NO_CLAUDE_CLI: "1" },
    noPersonal: true,
  };
  const getYnm = serviceCache(opts);
  const handle = await startHttp(() => createYnmServer(opts, getYnm), {
    port: 0,
    quiet: true,
    ...http,
  });
  return { handle, cwd };
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

describe.each<Provider>(["git-notes", "sqlite"])(
  "Streamable HTTP transport on %s (ADR-009, NFR-11)",
  (provider) => {
    it("serves health, rejects a missing bearer, and answers tool calls", async () => {
      const { handle } = await hosted(provider, { authToken: "secret" });
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
      const status = data<{ mounts: Array<{ provider: string }> }>(
        await client.callTool({ name: "memory_status", arguments: {} })
      );
      expect(status.mounts.map((m) => m.provider)).toEqual([provider]);
      await client.close();
      await handle.close();
    }, 30_000);

    it("two interleaved clients share the store but no per-request state", async () => {
      const { handle } = await hosted(provider);
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
  }
);

describe("token verifiers on the transport (ADR-009)", () => {
  it("answers a bad or missing token with an RFC 6750 challenge and enforces scopes", async () => {
    const { handle } = await hosted("git-notes", {
      verifier: new StaticTokenVerifier(["good"], ["memory:read"]),
      requiredScopes: ["memory:read"],
    });
    const missing = await fetch(handle.url, { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toMatch(/^Bearer/);
    const wrong = await fetch(handle.url, {
      method: "POST",
      headers: { Authorization: "Bearer nope" },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
    const client = await connect(handle.url, "good");
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
    await handle.close();
    const scoped = await hosted("git-notes", {
      verifier: new StaticTokenVerifier(["good"], ["memory:read"]),
      requiredScopes: ["memory:write"],
    });
    const forbidden = await fetch(scoped.handle.url, {
      method: "POST",
      headers: { Authorization: "Bearer good" },
      body: "{}",
    });
    expect(forbidden.status).toBe(403);
    await scoped.handle.close();
  }, 30_000);

  it("health carries the operator's extra fields outside auth", async () => {
    const { handle } = await hosted("sqlite", {
      authToken: "x",
      health: () => ({ scheduler: { dreamRuns: 3 } }),
    });
    const h = (await (await fetch(`http://localhost:${handle.port}/health`)).json()) as {
      scheduler: { dreamRuns: number };
    };
    expect(h.scheduler.dreamRuns).toBe(3);
    await handle.close();
  });
});
