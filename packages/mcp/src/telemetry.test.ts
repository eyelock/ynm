import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AuthInfo, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { type MemoryRecord, ulid } from "@ynm/model";
import { RemoteStore } from "@ynm/service";
import { FsLog } from "@ynm/store";
import { shutdownTelemetry, startTelemetry, withSpan } from "@ynm/telemetry";
import { type MemoryTelemetry, readSpool, startMemoryTelemetry } from "@ynm/telemetry/testing";
import { type AuditEvent, Auditor, type AuditSink, auditSinkFromEnv, otelSink } from "./audit.js";
import { USERNAME_EXTRA } from "./auth.js";
import { handleOf, hostedAudit, loginOf } from "./identity.js";
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
  await shutdownTelemetry();
});

const spoolDir = () => join(mkdtempSync(join(tmpdir(), "ynm-spool-")), "services", "ynm");

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
      // No ynr spool from the developer's home: the test config points this nowhere.
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
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

describe("passing the trace on to a remote mount", () => {
  /** A hosted ynm on a local port, behind a token, as a remote mount reaches it. */
  async function hosted() {
    const home = join(mkdtempSync(join(tmpdir(), "ynm-otel-remote-")), ".ynm");
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
      env: { ...process.env, YNM_HOME: home, YNM_USER: "hosted", YNM_NO_CLAUDE_CLI: "1" },
      noPersonal: true,
    };
    const getYnm = serviceCache(opts);
    return startHttp(() => createYnmServer(opts, getYnm), {
      port: 0,
      host: "127.0.0.1",
      quiet: true,
      authToken: "secret",
    });
  }

  /** A remote mount whose requests are recorded as they leave, headers and all. */
  function mount(url: string, sent: Headers[]) {
    return new RemoteStore({
      id: "team",
      url,
      authProvider: { token: async () => "secret" },
      timeoutMs: 10_000,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        sent.push(new Headers(init?.headers));
        return fetch(input, init);
      }) as typeof fetch,
    });
  }

  it("is a client span, and the hosted server's spans join it through the headers and _meta", async () => {
    telemetry = await startMemoryTelemetry();
    const handle = await hosted();
    const sent: Headers[] = [];
    const remote = mount(handle.url, sent);
    try {
      await withSpan("ynm status", {}, () => remote.call("memory_status", {}));
    } finally {
      await remote.close();
      await handle.close();
    }
    const { spans, logs } = await telemetry.exported();
    const command = spans.find((s) => s.name === "ynm status");
    const client = spans.find((s) => s.name === "tools/call memory_status" && s.kind === 2);
    expect(client).toMatchObject({
      traceId: command?.traceId,
      parentSpanId: command?.spanId,
      attributes: {
        "mcp.method.name": "tools/call",
        "gen_ai.tool.name": "memory_status",
        "ynm.mount": "team",
        "server.address": "127.0.0.1",
        "ynm.outcome": "ok",
      },
    });
    expect(logs.find((l) => l.eventName === "ynm.remote.started")?.spanId).toBe(client?.spanId);
    // Every request the call made carried the client span's context.
    const tp = `00-${client?.traceId}-${client?.spanId}-01`;
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map((h) => h.get("traceparent"))).toEqual(sent.map(() => tp));
    expect(sent.every((h) => h.get("authorization") === "Bearer secret")).toBe(true);
    // The hosted server joined it: its request spans through the headers, its tool span through
    // the call's _meta (otherwise it would be a child of its request span).
    const requests = spans.filter((s) => s.name === "POST /mcp");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((s) => s.parentSpanId === client?.spanId)).toBe(true);
    const served = spans.find((s) => s.name === "tools/call memory_status" && s.kind === 1);
    expect(served).toMatchObject({ traceId: client?.traceId, parentSpanId: client?.spanId });
  }, 30_000);

  it("sends exactly what it did before when telemetry is off", async () => {
    const handle = await hosted();
    const sent: Headers[] = [];
    const remote = mount(handle.url, sent);
    try {
      await withSpan("ynm status", {}, () => remote.call("memory_status", {}));
    } finally {
      await remote.close();
      await handle.close();
    }
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((h) => h.has("traceparent") || h.has("tracestate"))).toBe(false);
  }, 30_000);
});

describe("to a ynr spool", () => {
  it("an HTTP request with a traceparent writes its server span into the caller's trace", async () => {
    const dir = spoolDir();
    expect(await startTelemetry({ version: "1", env: { YNR_SPOOL: dir } })).toBe(true);
    const home = join(mkdtempSync(join(tmpdir(), "ynm-otel-spool-http-")), ".ynm");
    mkdirSync(home, { recursive: true });
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
    });
    try {
      const client = new Client({ name: "otel-test", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(handle.url), {
          requestInit: { headers: { traceparent } },
        })
      );
      await client.callTool({ name: "memory_status", arguments: {} });
      await client.close();
    } finally {
      await handle.close();
    }
    await shutdownTelemetry();
    const spooled = readSpool(dir);
    const requests = spooled.spans.filter((s) => s.name === "POST /mcp");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((s) => s.traceId === TRACE && s.parentSpanId === PARENT)).toBe(true);
    expect(requests.every((s) => s.kind === 2)).toBe(true);
    const tool = spooled.spans.find((s) => s.name === "tools/call memory_status");
    expect(requests.map((s) => s.spanId)).toContain(tool?.parentSpanId);
    expect(spooled.events).toEqual(
      expect.arrayContaining(["ynm.request.started", "ynm.tool.started"])
    );
    expect(spooled.metrics).toContain("ynm.http.request.duration");
  }, 30_000);

  it("a Lambda request puts its spans on disk before it returns", async () => {
    const dir = spoolDir();
    const { env } = lambdaEnv({ YNR_SPOOL: dir });
    const handler = createLambdaHandler({ env, quiet: true });
    const client = await connect(viaLambda(handler), { traceparent });
    await client.callTool({ name: "memory_status", arguments: {} });
    // No shutdown: what the invocation wrote is already in the open file.
    const spooled = readSpool(dir);
    expect(spooled.files.some((f) => f.endsWith(".open.jsonl"))).toBe(true);
    expect(spooled.spans.some((s) => s.name === "tools/call memory_status")).toBe(true);
    await client.close();
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

  it("writes none of it to a ynr spool either", async () => {
    const dir = spoolDir();
    const on = lambdaEnv({ YNM_AUDIT: '{"sink":"otel"}', YNR_SPOOL: dir });
    await scenario(on.env);
    await shutdownTelemetry();
    const spooled = readSpool(dir);
    expect(spooled.spans.length).toBeGreaterThan(5);
    expect(spooled.events).toContain("ynm.audit.request");
    expect(spooled.spans.some((s) => s.name === "dream")).toBe(true);
    expect(spooled.metrics.length).toBeGreaterThan(0);
    expect(spooled.text).not.toContain(CANARY);
    expect(spooled.text.toLowerCase()).not.toContain(CANARY.toLowerCase());
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

  it("names a signed-in person by sign-in name and issuer host, never by email", () => {
    const info = (extra: Record<string, unknown>): AuthInfo => ({
      token: "t",
      clientId: "c",
      scopes: [],
      extra,
    });
    const SUB = "0b7c2f1e-uuid";
    // preferred_username present: it names the person, not the opaque subject.
    expect(handleOf(info({ iss: ISSUER, sub: SUB, [USERNAME_EXTRA]: "alice" }))).toBe(
      "idp.example.com/alice"
    );
    // Absent: the subject stands in.
    expect(handleOf(info({ iss: ISSUER, sub: "alice" }))).toBe("idp.example.com/alice");
    expect(handleOf(info({ iss: "not a url", sub: "alice" }))).toBe("not a url/alice");
    // An email sign-in name is never used: the subject stands in.
    expect(handleOf(info({ iss: ISSUER, sub: SUB, [USERNAME_EXTRA]: "alice@example.com" }))).toBe(
      `idp.example.com/${SUB}`
    );
    // Both emails: no handle.
    expect(
      handleOf(
        info({ iss: ISSUER, sub: "alice@example.com", [USERNAME_EXTRA]: "alice@example.com" })
      )
    ).toBeUndefined();
    expect(handleOf(info({ iss: ISSUER, sub: "alice@example.com" }))).toBeUndefined();
    // No subject is no signed-in person, whatever name the token carries.
    expect(handleOf(info({ iss: ISSUER, [USERNAME_EXTRA]: "alice" }))).toBeUndefined();
    expect(handleOf(info({ iss: ISSUER }))).toBeUndefined();
    expect(handleOf(undefined)).toBeUndefined();
  });

  it("reads preferred_username for the handle only: the person id is the issuer and subject's", async () => {
    const home = join(mkdtempSync(join(tmpdir(), "ynm-otel-person-")), ".ynm");
    const opts = {
      cwd: home,
      env: { ...process.env, YNM_HOME: home, YNM_USER: "h", YNM_NO_CLAUDE_CLI: "1" },
      noPersonal: true,
    };
    const getYnm = serviceCache(opts);
    const { identify } = hostedAudit({ YNM_AUDIT: '{"sink":"off"}' }, true, getYnm);
    const base = { token: "t", clientId: "c", scopes: [] };
    const named = await identify({
      ...base,
      extra: { iss: ISSUER, sub: "0b7c", [USERNAME_EXTRA]: "alice" },
    });
    const renamed = await identify({
      ...base,
      extra: { iss: ISSUER, sub: "0b7c", [USERNAME_EXTRA]: "alice2" },
    });
    const unnamed = await identify({ ...base, extra: { iss: ISSUER, sub: "0b7c" } });
    expect(named).toBeDefined();
    expect(renamed).toBe(named);
    expect(unnamed).toBe(named);
    expect(
      loginOf({ ...base, extra: { iss: ISSUER, sub: "0b7c", [USERNAME_EXTRA]: "alice" } })
    ).toEqual({ issuer: ISSUER, subject: "0b7c" });
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
          extra: { iss: ISSUER, sub: "0b7c2f1e", [USERNAME_EXTRA]: "alice" },
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
    // The subject is not the handle when the token carries a sign-in name.
    expect(JSON.stringify(audits)).not.toContain("0b7c2f1e");
  }, 30_000);
});
