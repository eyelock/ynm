import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AuthInfo, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { type MemoryRecord, ulid } from "@ynm/model";
import { FsLog } from "@ynm/store";
import { type MemoryTelemetry, startMemoryTelemetry } from "@ynm/telemetry/testing";
import { type AuditEvent, Auditor, type AuditSink, auditSinkFromEnv, otelSink } from "./audit.js";
import { handleOf, hostedAudit } from "./identity.js";
import { createLambdaHandler, type FunctionUrlEvent, type LambdaHandler } from "./lambda.js";
import { createYnmServer, serviceCache } from "./server.js";
import { startHttp } from "./transport/http.js";

const PUBLIC = new URL("https://memory.example.com/mcp");
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT = "00f067aa0ba902b7";
const traceparent = `00-${TRACE}-${PARENT}-01`;
const ISSUER = "https://idp.example.com/realms/eng";

let telemetry: MemoryTelemetry | undefined;
afterEach(async () => {
  await telemetry?.stop();
  telemetry = undefined;
});

/** A fetch that goes through the Lambda handler as a Function URL would call it. */
function viaLambda(handler: LambdaHandler): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const url = new URL(req.url);
    const text = req.method === "GET" ? undefined : await req.text();
    const event: FunctionUrlEvent = {
      version: "2.0",
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      headers,
      body: text,
      requestContext: { http: { method: req.method } },
    };
    const result = (await handler(event, { getRemainingTimeInMillis: () => 60_000 })) as {
      statusCode: number;
      headers: Record<string, string>;
      body: string;
    };
    return new Response([204, 304].includes(result.statusCode) ? null : result.body, {
      status: result.statusCode,
      headers: result.headers,
    });
  };
}

/** A function serving one fresh fs store, configured by environment as it would be on AWS. */
function lambdaEnv(extra: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "ynm-otel-"));
  const store = join(root, "store");
  return {
    store,
    env: {
      YNM_PUBLIC_URL: PUBLIC.href,
      YNM_LAMBDA_ALLOW_OPEN: "1",
      YNM_HOME: join(root, "home"),
      YNM_USER: "lambda",
      YNM_MOUNTS: JSON.stringify([
        { id: "team", level: "distributed", provider: "fs", path: store },
      ]),
      ...extra,
    },
  };
}

async function connect(fetchImpl: typeof fetch, headers: Record<string, string> = {}) {
  const client = new Client({ name: "otel-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(PUBLIC), {
      fetch: fetchImpl,
      requestInit: { headers },
    })
  );
  return client;
}

describe("trace context", () => {
  it("an MCP call carrying traceparent produces a server span in that trace, with tool and store spans under it", async () => {
    telemetry = await startMemoryTelemetry();
    const { env } = lambdaEnv();
    const handler = createLambdaHandler({ env, quiet: true });
    const client = await connect(viaLambda(handler), { traceparent });
    await client.callTool({
      name: "memory_remember",
      arguments: { type: "semantic", level: "distributed", content: "spans join traces" },
    });
    await client.close();
    const { spans, logs } = await telemetry.exported();
    const tool = spans.find((s) => s.name === "tools/call memory_remember");
    expect(tool).toMatchObject({
      traceId: TRACE,
      kind: 1,
      attributes: {
        "mcp.method.name": "tools/call",
        "gen_ai.tool.name": "memory_remember",
        "ynm.outcome": "ok",
      },
    });
    const request = spans.find((s) => s.spanId === tool?.parentSpanId);
    expect(request).toMatchObject({
      name: "POST /mcp",
      traceId: TRACE,
      parentSpanId: PARENT,
      attributes: {
        "http.request.method": "POST",
        "http.route": "/mcp",
        "http.response.status_code": 200,
        "ynm.outcome": "ok",
      },
    });
    const append = spans.find((s) => s.name === "store append");
    expect(append).toMatchObject({
      traceId: TRACE,
      parentSpanId: tool?.spanId,
      kind: 2,
      attributes: { "ynm.mount": "team", "ynm.store.provider": "fs", "ynm.record.count": 1 },
    });
    const started = logs.map((l) => l.eventName);
    expect(started).toEqual(
      expect.arrayContaining(["ynm.request.started", "ynm.tool.started", "ynm.store.started"])
    );
    expect(logs.find((l) => l.eventName === "ynm.tool.started")?.spanId).toBe(tool?.spanId);
  }, 30_000);

  it("ynm serve --http joins the caller's trace too, and a refusal ends as refused", async () => {
    telemetry = await startMemoryTelemetry();
    const home = join(mkdtempSync(join(tmpdir(), "ynm-otel-http-")), ".ynm");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        mounts: [
          { id: "project", level: "distributed", provider: "sqlite", path: join(home, "s") },
        ],
      })
    );
    const opts = {
      cwd: home,
      env: { ...process.env, YNM_HOME: home, YNM_USER: "http", YNM_NO_CLAUDE_CLI: "1" },
      noPersonal: true,
    };
    const getYnm = serviceCache(opts);
    const handle = await startHttp(() => createYnmServer(opts, getYnm), {
      port: 0,
      host: "127.0.0.1",
      quiet: true,
      authToken: "secret",
    });
    try {
      const refused = await fetch(handle.url, { method: "POST", headers: { traceparent } });
      expect(refused.status).toBe(401);
      const client = new Client({ name: "otel-test", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(handle.url), {
          requestInit: { headers: { traceparent, Authorization: "Bearer secret" } },
        })
      );
      await client.callTool({ name: "memory_status", arguments: {} });
      await client.close();
    } finally {
      await handle.close();
    }
    const { spans } = await telemetry.exported();
    const requests = spans.filter((s) => s.name === "POST /mcp");
    expect(requests.every((s) => s.traceId === TRACE && s.parentSpanId === PARENT)).toBe(true);
    expect(requests.map((s) => s.attributes["ynm.outcome"])).toContain("refused");
    const tool = spans.find((s) => s.name === "tools/call memory_status");
    expect(requests.map((s) => s.spanId)).toContain(tool?.parentSpanId);
  }, 30_000);
});

describe("no content in telemetry", () => {
  const CANARY = "CANARY-7f3e9b";

  /** Remembers, recalls and consolidates with the canary in every field a caller controls. */
  async function scenario(env: NodeJS.ProcessEnv): Promise<void> {
    const handler = createLambdaHandler({ env, quiet: true });
    const client = await connect(viaLambda(handler));
    for (const i of [1, 2])
      await client.callTool({
        name: "memory_remember",
        arguments: {
          type: "semantic",
          level: "distributed",
          namespace: `org/${CANARY.toLowerCase()}`,
          subject: `entity:${CANARY}`,
          tags: [CANARY],
          summary: `${CANARY} summary`,
          content: `The ${CANARY} body says the release gate is green (${i})`,
        },
      });
    await client.callTool({ name: "memory_recall", arguments: { text: `${CANARY} release gate` } });
    await client.callTool({ name: "memory_context", arguments: {} });
    await client.callTool({ name: "memory_consolidate", arguments: {} });
    await client.close();
  }

  /** The store's records, without what differs from run to run (ids and times). */
  async function records(store: string): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const r of new FsLog("team", "distributed", store).scan()) {
      const {
        id: _i,
        memoryId: _m,
        recordedAt: _r,
        validFrom: _v,
        links,
        data,
        ...rest
      } = r as MemoryRecord;
      out.push({ ...rest, links: links.length, data: data ? Object.keys(data).sort() : undefined });
    }
    return out.map((x) => JSON.stringify(x)).sort();
  }

  it("exports no body, summary, query, subject, tag or namespace, and leaves the store as it would be without telemetry", async () => {
    const off = lambdaEnv();
    await scenario(off.env);

    telemetry = await startMemoryTelemetry();
    const on = lambdaEnv({ YNM_AUDIT: '{"sink":"otel"}' });
    await scenario(on.env);
    const { spans, logs, text } = await telemetry.exported();

    expect(spans.length).toBeGreaterThan(5);
    expect(logs.some((l) => l.eventName === "ynm.audit.request")).toBe(true);
    expect(spans.some((s) => s.name === "dream")).toBe(true);
    expect(text).not.toContain(CANARY);
    expect(text.toLowerCase()).not.toContain(CANARY.toLowerCase());
    expect(await records(on.store)).toEqual(await records(off.store));
    // The canary is in the store, so its absence above is telemetry's doing.
    expect(JSON.stringify(await records(on.store))).toContain(CANARY);
  }, 60_000);
});

describe("the otel audit sink", () => {
  const event: AuditEvent = {
    at: "2026-10-05T09:14:03.120Z",
    id: ulid(),
    person: "pabcdefghijklmnop",
    client: "claude-code",
    method: "POST",
    path: "/mcp",
    status: 200,
    outcome: "ok",
    calls: [
      {
        tool: "memory_recall",
        status: "ok",
        memoryIds: ["01A", "01B"],
        inputBytes: 30,
        resultCount: 2,
      },
      { tool: "memory_remember", status: "error", inputBytes: 12 },
    ],
    durationMs: 23,
  };

  it("emits one event of metadata, with the person as a handle, after the redaction patterns", async () => {
    telemetry = await startMemoryTelemetry({ version: "1", redaction: ["AKIA[0-9A-Z]{16}"] });
    await otelSink().write(
      { ...event, path: "/mcp/AKIAABCDEFGHIJKLMNOP" },
      { handle: "idp.example.com/alice" }
    );
    const { logs } = await telemetry.exported();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      eventName: "ynm.audit.request",
      attributes: {
        "ynm.audit.id": event.id,
        "user.name": "idp.example.com/alice",
        "ynm.actor.kind": "human",
        "ynm.client.id": "claude-code",
        "url.path": "/mcp/[REDACTED]",
        "http.response.status_code": 200,
        "ynm.outcome": "ok",
        "ynm.audit.tools": ["memory_recall", "memory_remember"],
        "ynm.audit.call.count": 2,
        "ynm.audit.error.count": 1,
        "ynm.memory.ids": ["01A", "01B"],
        "ynm.input.bytes": 42,
        "ynm.result.count": 2,
        "ynm.audit.duration_ms": 23,
      },
    });
    expect(JSON.stringify(logs)).not.toContain(event.person);
  });

  it("is chosen by YNM_AUDIT only while telemetry is on", async () => {
    await expect(
      auditSinkFromEnv({ YNM_AUDIT: '{"sink":"otel"}' }, { authenticated: true })
    ).rejects.toThrow(/telemetry, which is off/);
    telemetry = await startMemoryTelemetry();
    expect(
      await auditSinkFromEnv({ YNM_AUDIT: '{"sink":"otel"}' }, { authenticated: true })
    ).toBeDefined();
  });

  it("gets the handle beside the event, so ynm's own sinks write exactly what they did", async () => {
    const seen: Array<[AuditEvent, unknown]> = [];
    const sink: AuditSink = { write: async (e, c) => void seen.push([e, c]) };
    await new Auditor(sink).around({ method: "POST", url: "/mcp" }, async () => ({
      status: 200,
      person: "p1",
      handle: "idp.example.com/alice",
    }));
    expect(seen[0]?.[1]).toEqual({ handle: "idp.example.com/alice" });
    expect(JSON.stringify(seen[0]?.[0])).not.toContain("alice");
    expect(Object.keys(seen[0]?.[0] ?? {})).not.toContain("handle");
  });

  it("names a signed-in person by sign-in id and issuer host, never by email", () => {
    const info = (extra: Record<string, unknown>): AuthInfo => ({
      token: "t",
      clientId: "c",
      scopes: [],
      extra,
    });
    expect(handleOf(info({ iss: ISSUER, sub: "alice" }))).toBe("idp.example.com/alice");
    expect(handleOf(info({ iss: "not a url", sub: "alice" }))).toBe("not a url/alice");
    expect(handleOf(info({ iss: ISSUER, sub: "alice@example.com" }))).toBeUndefined();
    expect(handleOf(info({ iss: ISSUER }))).toBeUndefined();
    expect(handleOf(undefined)).toBeUndefined();
  });

  it("carries a signed-in caller's handle from a hosted server's audit", async () => {
    telemetry = await startMemoryTelemetry();
    const verifier: OAuthTokenVerifier = {
      async verifyAccessToken(token) {
        return {
          token,
          clientId: "claude-code",
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          extra: { iss: ISSUER, sub: "alice" },
        };
      },
    };
    const home = join(mkdtempSync(join(tmpdir(), "ynm-otel-audit-")), ".ynm");
    const opts = {
      cwd: home,
      env: { ...process.env, YNM_HOME: home, YNM_USER: "h", YNM_NO_CLAUDE_CLI: "1" },
      noPersonal: true,
    };
    const getYnm = serviceCache(opts);
    const handle = await startHttp(() => createYnmServer(opts, getYnm), {
      port: 0,
      host: "127.0.0.1",
      quiet: true,
      verifier,
      ...hostedAudit({ YNM_AUDIT: '{"sink":"otel"}' }, true, getYnm),
    });
    try {
      const client = new Client({ name: "otel-test", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(handle.url), {
          requestInit: { headers: { Authorization: "Bearer any" } },
        })
      );
      await client.callTool({ name: "memory_status", arguments: {} });
      await client.close();
    } finally {
      await handle.close();
    }
    const audits = (await telemetry.exported()).logs.filter(
      (l) => l.eventName === "ynm.audit.request"
    );
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((a) => a.attributes["user.name"] === "idp.example.com/alice")).toBe(true);
    expect(audits.every((a) => a.attributes["ynm.actor.kind"] === "human")).toBe(true);
  }, 30_000);
});
