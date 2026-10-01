import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
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

/** A server with one tool and no store, for transport behaviour that never reaches memory. */
function bare(): McpServer {
  const server = new McpServer({ name: "bare", version: "0" }, { capabilities: { tools: {} } });
  server.registerTool("ping", { description: "answers pong" }, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  return server;
}

/** fetch() forbids setting Host, so raw requests go through node:http. */
function raw(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string | string[]> }
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "localhost",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/mcp",
        headers: opts.headers,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("HTTP front door: CORS, host and origin checks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a preflight from an allowed origin with CORS headers and no auth", async () => {
    const handle = await startHttp(bare, {
      port: 0,
      quiet: true,
      authToken: "secret",
      allowedOrigins: ["https://app.example"],
    });
    const pre = await fetch(handle.url, {
      method: "OPTIONS",
      headers: { Origin: "https://app.example" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(pre.headers.get("vary")).toBe("Origin");
    expect(pre.headers.get("access-control-allow-headers")).toMatch(/Authorization/);
    const other = await fetch(handle.url, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    expect(other.status).toBe(204);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    await handle.close();
  });

  it("rejects a foreign origin and a foreign Host header before auth or the handler", async () => {
    const handle = await startHttp(bare, { port: 0, quiet: true, authToken: "secret" });
    const origin = await fetch(handle.url, {
      method: "POST",
      headers: { Origin: "https://evil.example", Authorization: "Bearer secret" },
      body: "{}",
    });
    expect(origin.status).toBe(403);
    expect(origin.headers.get("content-type")).toBe("application/json");
    const host = await raw(handle.port, {
      method: "POST",
      headers: { Host: "evil.example", Authorization: "Bearer secret" },
    });
    expect(host.status).toBe(403);
    expect(host.body).toMatch(/host/i);
    await handle.close();
  });

  it("a wildcard host list accepts any Host header", async () => {
    const handle = await startHttp(bare, { port: 0, quiet: true, allowedHosts: ["*"] });
    const r = await raw(handle.port, {
      method: "GET",
      path: "/health",
      headers: { Host: "memory.internal" },
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ status: "ok", name: "ynm" });
    const mcp = await raw(handle.port, {
      method: "DELETE",
      headers: { Host: "memory.internal" },
    });
    // Past the host check, the MCP handler itself answers (stateless: no DELETE).
    expect(mcp.status).toBe(405);
    expect(JSON.parse(mcp.body).error.message).toMatch(/Method not allowed/);
    await handle.close();
  });

  it("refuses a non-Bearer Authorization with a realm challenge", async () => {
    const handle = await startHttp(bare, {
      port: 0,
      quiet: true,
      authToken: "secret",
      rejectLegacy: true,
    });
    const r = await fetch(handle.url, {
      method: "POST",
      headers: { Authorization: "Basic c2VjcmV0" },
      body: "{}",
    });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe('Bearer realm="ynm"');
    expect(await r.json()).toEqual({ error: "Unauthorized" });
    await handle.close();
  });

  it("passes repeated request headers through and serves a client with a static token", async () => {
    const handle = await startHttp(bare, { port: 0, quiet: true, authToken: "secret" });
    const r = await raw(handle.port, {
      method: "POST",
      headers: { "Set-Cookie": ["a=1", "b=2"] },
    });
    expect(r.status).toBe(401);
    const client = await connect(handle.url, "secret");
    const pong = await client.callTool({ name: "ping", arguments: {} });
    expect((pong.content as Array<{ text: string }>)[0]?.text).toBe("pong");
    await client.close();
    await handle.close();
  });

  it("logs the listening address and serving errors to stderr unless quiet", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = await startHttp(
      () => {
        throw new Error("factory broke");
      },
      { port: 0, host: "127.0.0.1" }
    );
    expect(err).toHaveBeenCalledWith(
      `ynm-mcp listening on http://127.0.0.1:${handle.port}/mcp (health: http://127.0.0.1:${handle.port}/health)`
    );
    const client = new Client({ name: "http-test", version: "0" });
    await expect(
      client.connect(new StreamableHTTPClientTransport(new URL(handle.url)))
    ).rejects.toThrow();
    expect(err.mock.calls.some(([m]) => /^\[ynm-mcp\] .*factory broke/.test(String(m)))).toBe(true);
    await handle.close();
  });
});
