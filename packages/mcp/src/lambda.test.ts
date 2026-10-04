import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DEFAULT_REDACTION, IndexManager, Ynm } from "@ynm/service";
import { MemoryLog, type ShardKey } from "@ynm/store";
import {
  bufferResult,
  createLambdaHandler,
  type FunctionUrlEvent,
  type FunctionUrlResult,
  type LambdaContext,
  type LambdaHandler,
  lambdaConfig,
  toRequest,
  toResult,
} from "./lambda.js";
import { serviceCache } from "./server.js";

const PUBLIC = new URL("https://memory.example.com/mcp");

function event(over: Partial<FunctionUrlEvent> & { method?: string } = {}): FunctionUrlEvent {
  const { method = "GET", ...rest } = over;
  return {
    version: "2.0",
    rawPath: "/mcp",
    rawQueryString: "",
    headers: { host: "abc123.lambda-url.eu-west-2.on.aws" },
    requestContext: { http: { method }, domainName: "abc123.lambda-url.eu-west-2.on.aws" },
    ...rest,
  };
}

/** A fetch that goes through the Lambda handler as a Function URL would call it. */
function viaLambda(
  handler: LambdaHandler,
  { base64 = false, context }: { base64?: boolean; context?: () => LambdaContext } = {}
): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    let cookies: string[] | undefined;
    req.headers.forEach((value, name) => {
      if (name === "cookie") cookies = value.split("; ");
      else headers[name] = value;
    });
    const url = new URL(req.url);
    const text = req.method === "GET" ? undefined : await req.text();
    const result = (await handler(
      event({
        method: req.method,
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers,
        cookies,
        body: text === undefined ? undefined : base64 ? Buffer.from(text).toString("base64") : text,
        isBase64Encoded: base64 && text !== undefined,
      }),
      context?.()
    )) as FunctionUrlResult;
    const out = new Headers(result.headers);
    for (const c of result.cookies ?? []) out.append("set-cookie", c);
    const body = result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body;
    return new Response([204, 304].includes(result.statusCode) ? null : body, {
      status: result.statusCode,
      headers: out,
    });
  };
}

/** Environment for a function serving one fs store, as the container would be configured. */
function lambdaEnv(
  extra: NodeJS.ProcessEnv = {},
  provider: "fs" | "sqlite" = "fs"
): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "ynm-lambda-"));
  return {
    YNM_PUBLIC_URL: PUBLIC.href,
    // Most tests drive the handler without auth; the refusal itself is tested below.
    YNM_LAMBDA_ALLOW_OPEN: "1",
    YNM_HOME: join(root, "home"),
    YNM_USER: "lambda",
    YNM_MOUNTS: JSON.stringify([
      { id: "team", level: "distributed", provider, path: join(root, "store") },
    ]),
    ...extra,
  };
}

function data<T>(r: { structuredContent?: unknown; isError?: boolean; content: unknown }): T {
  if (r.isError) throw new Error(JSON.stringify(r.content));
  return (r.structuredContent as { data: T }).data;
}

describe("Function URL event to Request", () => {
  it("carries method, raw path and query, headers and cookies, under the public host", async () => {
    const req = toRequest(
      event({
        method: "post",
        rawPath: "/mcp/x",
        rawQueryString: "a=1&b=two%20words&a=3",
        headers: { "content-type": "application/json", accept: "text/html, application/json" },
        cookies: ["a=1", "b=2"],
        body: '{"x":1}',
      }),
      PUBLIC
    );
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://memory.example.com/mcp/x?a=1&b=two%20words&a=3");
    expect(new URL(req.url).searchParams.getAll("a")).toEqual(["1", "3"]);
    expect(req.headers.get("host")).toBe("memory.example.com");
    expect(req.headers.get("accept")).toBe("text/html, application/json");
    expect(req.headers.get("cookie")).toBe("a=1; b=2");
    expect(await req.json()).toEqual({ x: 1 });
  });

  it("decodes a base64 body byte for byte and ignores a body on GET", async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    const req = toRequest(
      event({ method: "PUT", body: bytes.toString("base64"), isBase64Encoded: true }),
      PUBLIC
    );
    expect(Buffer.from(await req.arrayBuffer())).toEqual(bytes);
    const get = toRequest(event({ body: "ignored" }), PUBLIC);
    expect(get.body).toBeNull();
  });

  it("keeps a path that starts with two slashes on the public host", () => {
    const req = toRequest(event({ rawPath: "//evil.example/x" }), PUBLIC);
    expect(new URL(req.url).host).toBe("memory.example.com");
    expect(toRequest(event({ rawPath: "" }), PUBLIC).url).toBe("https://memory.example.com/");
  });
});

describe("Response to Function URL result", () => {
  it("returns text as is, binary as base64, and Set-Cookie as cookies", async () => {
    const headers = new Headers({ "content-type": "application/json", vary: "Origin" });
    headers.append("vary", "Accept");
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    const text = await toResult(new Response('{"ok":true}', { status: 201, headers }));
    expect(text).toEqual({
      statusCode: 201,
      headers: { "content-type": "application/json", vary: "Origin, Accept" },
      cookies: ["a=1; Path=/", "b=2; Path=/"],
      body: '{"ok":true}',
      isBase64Encoded: false,
    });
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
    const bin = await toResult(
      new Response(bytes, { headers: { "content-type": "application/octet-stream" } })
    );
    expect(bin.isBase64Encoded).toBe(true);
    expect(Buffer.from(bin.body, "base64")).toEqual(bytes);
    expect(bin.cookies).toBeUndefined();
    const empty = await toResult(new Response(null, { status: 204 }));
    expect(empty).toMatchObject({ statusCode: 204, body: "", isBase64Encoded: false });
    const sse = await toResult(
      new Response("event: message\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    );
    expect(sse.isBase64Encoded).toBe(false);
  });

  it("cuts off a stream that never ends with what it had sent, and says so", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: first\n\n"));
      },
    });
    const r = await toResult(
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      { timeoutMs: 50 }
    );
    expect(r.body).toBe("data: first\n\n");
    const whole = await bufferResult(new Response("done"), { timeoutMs: 1_000 });
    expect(whole.truncated).toBe(false);
    const never = new ReadableStream<Uint8Array>({ start() {} });
    const cut = await bufferResult(new Response(never), { timeoutMs: 20 });
    expect(cut).toMatchObject({ truncated: true, result: { statusCode: 200, body: "" } });
  });
});

describe("Lambda configuration", () => {
  it("requires YNM_PUBLIC_URL and says what to set", () => {
    expect(() => lambdaConfig({})).toThrow(/YNM_PUBLIC_URL is not set/);
    expect(() => createLambdaHandler({ env: {}, quiet: true })).toThrow(/YNM_PUBLIC_URL/);
    expect(() => lambdaConfig({ YNM_PUBLIC_URL: "not a url" })).toThrow(/not a URL/);
    expect(() => lambdaConfig({ YNM_PUBLIC_URL: "ftp://x.example" })).toThrow(/http or https/);
  });

  it("refuses to start without authentication unless told it may run open", () => {
    const open = { ...lambdaEnv(), YNM_LAMBDA_ALLOW_OPEN: undefined };
    expect(() => createLambdaHandler({ env: open, quiet: true })).toThrow(
      /No authentication is configured/
    );
    expect(() =>
      createLambdaHandler({ env: { ...open, YNM_MCP_TOKEN: "t" }, quiet: true })
    ).not.toThrow();
    expect(() =>
      createLambdaHandler({ env: { ...open, YNM_LAMBDA_ALLOW_OPEN: "1" }, quiet: true })
    ).not.toThrow();
  });

  it("puts the home under /tmp unless YNM_HOME says otherwise, and skips the claude probe", () => {
    const cfg = lambdaConfig({ YNM_PUBLIC_URL: "https://m.example/mcp" });
    expect(cfg.home).toBe("/tmp/ynm");
    expect(cfg.env.YNM_HOME).toBe("/tmp/ynm");
    expect(cfg.env.YNM_NO_CLAUDE_CLI).toBe("1");
    expect(cfg.publicUrl.hostname).toBe("m.example");
    expect(lambdaConfig({ YNM_PUBLIC_URL: "https://m.example", YNM_HOME: "/data" }).home).toBe(
      "/data"
    );
  });

  it("the exported handler fails clearly without YNM_PUBLIC_URL", async () => {
    vi.resetModules();
    vi.stubEnv("YNM_PUBLIC_URL", "");
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "");
    const mod = await import("./lambda.js");
    await expect(mod.handler({ ynm: "health" })).rejects.toThrow(/YNM_PUBLIC_URL is not set/);
    vi.unstubAllEnvs();
  });
});

describe("Lambda handler over Function URL events (ADR-009)", () => {
  it.each(["fs", "sqlite"] as const)(
    "serves initialize, tools/list and tool calls against a %s store",
    async (provider) => {
      const handler = createLambdaHandler({ env: lambdaEnv({}, provider), quiet: true });
      for (const base64 of [false, true]) {
        const client = new Client({ name: "lambda-test", version: "0" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(PUBLIC), {
            fetch: viaLambda(handler, { base64 }),
          })
        );
        expect((await client.listTools()).tools).toHaveLength(11);
        const r = data<{ mount: string }>(
          await client.callTool({
            name: "memory_remember",
            arguments: { type: "semantic", level: "distributed", content: `lambda fact ${base64}` },
          })
        );
        expect(r.mount).toBe("team");
        await client.close();
      }
      const client = new Client({ name: "lambda-test", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(PUBLIC), { fetch: viaLambda(handler) })
      );
      expect(
        data<unknown[]>(
          await client.callTool({ name: "memory_recall", arguments: { text: "lambda fact" } })
        )
      ).toHaveLength(2);
      const status = data<{ mounts: Array<{ id: string; provider: string }> }>(
        await client.callTool({ name: "memory_status", arguments: {} })
      );
      // Never the personal mount: only what YNM_MOUNTS names.
      expect(status.mounts.map((m) => [m.id, m.provider])).toEqual([["team", provider]]);
      await client.close();
    },
    30_000
  );

  it("answers /health without auth and challenges a request without a token", async () => {
    const handler = createLambdaHandler({
      env: lambdaEnv({ YNM_MCP_TOKEN: "secret" }),
      quiet: true,
    });
    const health = (await handler(event({ rawPath: "/health" }))) as FunctionUrlResult;
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({
      status: "ok",
      auth: "bearer",
      runtime: "lambda",
    });
    const denied = (await handler(
      event({ method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    )) as FunctionUrlResult;
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["www-authenticate"]).toMatch(/^Bearer/);
    const client = new Client({ name: "lambda-test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(PUBLIC), {
        fetch: viaLambda(handler),
        requestInit: { headers: { Authorization: "Bearer secret" } },
      })
    );
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  }, 30_000);

  it("audits each MCP request and each refusal to the configured sink, never health checks", async () => {
    const auditLog = join(mkdtempSync(join(tmpdir(), "ynm-lambda-audit-")), "audit.jsonl");
    const env = lambdaEnv({
      YNM_MCP_TOKEN: "secret",
      YNM_AUDIT: JSON.stringify({ sink: "file", path: auditLog }),
    });
    const cfg = lambdaConfig(env);
    const getYnm = serviceCache({ cwd: cfg.home, env: cfg.env, noPersonal: true });
    const handler = createLambdaHandler({ env, getYnm, quiet: true });
    await handler(event({ rawPath: "/health" }));
    const denied = (await handler(
      event({ method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    )) as FunctionUrlResult;
    expect(denied.statusCode).toBe(401);
    const client = new Client({ name: "lambda-test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(PUBLIC), {
        fetch: viaLambda(handler),
        requestInit: { headers: { Authorization: "Bearer secret" } },
      })
    );
    const w = data<{ memoryId: string }>(
      await client.callTool({
        name: "memory_remember",
        arguments: {
          type: "semantic",
          level: "distributed",
          content: "A fact nobody should find in the audit log",
        },
      })
    );
    await client.close();
    const events = readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            outcome: string;
            reason?: string;
            person?: string;
            client?: string;
            calls: Array<{ tool: string; memoryIds?: string[] }>;
          }
      );
    expect(events[0]).toMatchObject({ outcome: "refused", reason: "invalid_token" });
    const remember = events.find((e) => e.calls.some((c) => c.tool === "memory_remember"));
    expect(remember?.calls[0]?.memoryIds).toEqual([w.memoryId]);
    // A shared token vouches for no one: no person, the shared client, and its writes recorded
    // as the token, never as the function's own user.
    expect(remember?.person).toBeUndefined();
    expect(remember?.client).toBe("static");
    expect((await (await getYnm()).find(w.memoryId))?.current.provenance.actor).toBe(
      "token:static"
    );
    expect(readFileSync(auditLog, "utf8")).not.toMatch(/nobody should find/);
  }, 30_000);

  it("checks Origin against the allowed list and answers a malformed request with a 500", async () => {
    const handler = createLambdaHandler({ env: lambdaEnv(), quiet: true });
    const foreign = (await handler(
      event({ method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })
    )) as FunctionUrlResult;
    expect(foreign.statusCode).toBe(403);
    const broken = (await handler(event({ headers: { "bad header": "x" } }), {
      getRemainingTimeInMillis: () => 5_000,
    })) as FunctionUrlResult;
    expect(broken.statusCode).toBe(500);
    expect(JSON.parse(broken.body)).toEqual({ error: "internal error" });
  });

  it("refuses an event it does not recognise", async () => {
    const handler = createLambdaHandler({ env: lambdaEnv(), quiet: true });
    await expect(handler({ source: "aws.events" })).rejects.toThrow(/unrecognised event/);
    await expect(handler({ ynm: "reindex" })).rejects.toThrow(/unknown scheduled task "reindex"/);
  });
});

function memoryYnm(log = new MemoryLog("org", "distributed")): Ynm {
  return new Ynm({
    mounts: [{ id: "org", level: "distributed", location: "mem", log }],
    actor: "lambda",
    userId: "lambda",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
  });
}

describe("Lambda handler over scheduled events", () => {
  it("health opens the service once and reports whether the instance was warm", async () => {
    let opens = 0;
    const ynm = memoryYnm();
    const handler = createLambdaHandler({
      env: lambdaEnv(),
      quiet: true,
      getYnm: async () => {
        opens += 1;
        return ynm;
      },
    });
    expect(await handler({ ynm: "health" })).toMatchObject({
      ynm: "health",
      status: "ok",
      warm: false,
    });
    expect(await handler({ ynm: "health" })).toMatchObject({ warm: true });
    expect(opens).toBe(2);
  });

  it("dream runs consolidation as the server's scheduler does, and a failing run fails the invocation", async () => {
    const ynm = memoryYnm();
    await ynm.remember({
      type: "working",
      level: "distributed",
      content: "scratch",
      ttl: "PT1S",
      namespace: "session/s",
    });
    const handler = createLambdaHandler({ env: lambdaEnv(), quiet: true, getYnm: async () => ynm });
    const r = await handler({ ynm: "dream" });
    expect(r).toMatchObject({ ynm: "dream", status: "ok" });
    expect((r as { passes: Record<string, unknown> }).passes).toHaveProperty("expire");
    const health = (await handler(event({ rawPath: "/health" }))) as FunctionUrlResult;
    expect(JSON.parse(health.body).scheduler.dreamRuns).toBe(1);
    const failing = createLambdaHandler({
      env: lambdaEnv(),
      quiet: true,
      getYnm: async () => {
        throw new Error("store offline");
      },
    });
    await expect(failing({ ynm: "dream" })).rejects.toThrow(/dream: store offline/);
  });

  it("compact calls a provider's compaction on every shard, and is a no-op that says so otherwise", async () => {
    const plain = memoryYnm();
    const noop = createLambdaHandler({ env: lambdaEnv(), quiet: true, getYnm: async () => plain });
    expect(await noop({ ynm: "compact" })).toEqual({
      ynm: "compact",
      status: "ok",
      mounts: [
        {
          mount: "org",
          provider: "memory",
          compacted: false,
          reason: "the memory provider has no compaction; nothing to do",
        },
      ],
    });

    const calls: ShardKey[] = [];
    const log = Object.assign(new MemoryLog("org", "distributed"), {
      compact: async (shard: ShardKey) => {
        calls.push(shard);
        return { merged: 3 };
      },
    });
    const ynm = memoryYnm(log);
    await ynm.remember({ type: "semantic", level: "distributed", content: "one", namespace: "a" });
    await ynm.remember({ type: "semantic", level: "distributed", content: "two", namespace: "b" });
    const handler = createLambdaHandler({ env: lambdaEnv(), quiet: true, getYnm: async () => ynm });
    const r = (await handler({ ynm: "compact" })) as { mounts: Array<Record<string, unknown>> };
    expect(r.mounts[0]).toMatchObject({ mount: "org", compacted: true, shards: 2 });
    expect(r.mounts[0]?.results).toEqual([{ merged: 3 }, { merged: 3 }]);
    expect(calls.map((s) => s.namespace).sort()).toEqual(["a", "b"]);
    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(["bucket", "level", "namespace", "type"]);
  });
});

/** A log sink that keeps every line, with its level. */
function capture() {
  const lines: string[] = [];
  return { lines, log: (level: string, line: string) => lines.push(`${level} ${line}`) };
}

describe("Lambda request and event log lines", () => {
  const TOKEN = "tok-Zq81-never-logged";

  it("logs one line per request with method, path, status, duration, rpc, tool, auth and id, and nothing secret", async () => {
    const { lines, log } = capture();
    const handler = createLambdaHandler({
      env: lambdaEnv({ YNM_MCP_TOKEN: TOKEN, YNM_AUDIT: '{"sink":"off"}' }),
      quiet: true,
      log,
    });
    let n = 0;
    const client = new Client({ name: "lambda-test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(PUBLIC), {
        fetch: viaLambda(handler, {
          context: () => ({ awsRequestId: `req-${++n}`, getRemainingTimeInMillis: () => 30_000 }),
        }),
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      })
    );
    data(
      await client.callTool({
        name: "memory_remember",
        arguments: { type: "semantic", level: "distributed", content: "a private plum fact" },
      })
    );
    await client.callTool({ name: "memory_recall", arguments: { text: "plum query words" } });
    await client.close();
    const requests = lines.filter((l) => l.includes("[ynm-mcp lambda] request "));
    expect(requests).toHaveLength(n);
    for (const l of requests)
      expect(l).toMatch(
        /^info \[ynm-mcp lambda\] request (POST|GET|DELETE) \/mcp \d{3} \d+ms .*auth=static.* id=req-\d+$/
      );
    expect(requests[0]).toMatch(/ cold /);
    expect(requests.filter((l) => / cold /.test(l))).toHaveLength(1);
    expect(
      requests.some((l) =>
        /request POST \/mcp 200 \d+ms rpc=tools\/call tool=memory_remember auth=static id=req-\d+$/.test(
          l
        )
      )
    ).toBe(true);
    expect(requests.some((l) => / rpc=tools\/call tool=memory_recall /.test(l))).toBe(true);
    const all = lines.join("\n");
    for (const secret of [TOKEN, "Bearer", "plum", "query words", "authorization"])
      expect(all).not.toContain(secret);
  }, 30_000);

  it("reads the rpc method and tool from a body without the standard headers, never the arguments", async () => {
    const { lines, log } = capture();
    const handler = createLambdaHandler({
      env: lambdaEnv({ YNM_MCP_TOKEN: TOKEN, YNM_AUDIT: '{"sink":"off"}' }),
      quiet: true,
      log,
    });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "memory_recall", arguments: { text: "the hidden query" } },
    });
    await handler(
      event({
        method: "POST",
        rawQueryString: "q=search-term",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: Buffer.from(body).toString("base64"),
        isBase64Encoded: true,
      }),
      { awsRequestId: "b-1" }
    );
    await handler(event({ method: "POST", body: "{}" }), { awsRequestId: "b-2" });
    await handler(event({ rawPath: "/health" }), { awsRequestId: "b-3" });
    expect(lines[0]).toMatch(
      /request POST \/mcp \d{3} \d+ms rpc=tools\/call tool=memory_recall auth=static cold id=b-1$/
    );
    expect(lines[1]).toMatch(
      /^info \[ynm-mcp lambda\] request POST \/mcp 401 \d+ms auth=refused id=b-2$/
    );
    expect(lines[2]).toMatch(/request GET \/health 200 \d+ms auth=public id=b-3$/);
    expect(lines.join("\n")).not.toMatch(/hidden|search-term|tok-/);
  });

  it("logs a failed request's error and its 500 with the same id", async () => {
    const { lines, log } = capture();
    const handler = createLambdaHandler({ env: lambdaEnv(), quiet: true, log });
    const r = (await handler(event({ headers: { "bad header": "x" } }), {
      awsRequestId: "fail-7",
      getRemainingTimeInMillis: () => 5_000,
    })) as FunctionUrlResult;
    expect(r.statusCode).toBe(500);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^error \[ynm-mcp lambda\] request failed id=fail-7: /);
    expect(lines[1]).toMatch(
      /^error \[ynm-mcp lambda\] request GET \/mcp 500 \d+ms cold id=fail-7$/
    );
  });

  it("marks a response cut off near the function's timeout", async () => {
    const { lines, log } = capture();
    // A store that never opens: the tool call never answers, and its stream is cut at the deadline.
    const handler = createLambdaHandler({
      env: lambdaEnv(),
      quiet: true,
      log,
      getYnm: () => new Promise(() => {}),
    });
    const r = (await handler(
      event({
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "memory_status", arguments: {} },
        }),
      }),
      { awsRequestId: "slow-1", getRemainingTimeInMillis: () => 1_100 }
    )) as FunctionUrlResult;
    expect(r.statusCode).toBe(200);
    expect(lines).toEqual([
      expect.stringMatching(
        /^error \[ynm-mcp lambda\] request POST \/mcp 200 \d+ms rpc=tools\/call tool=memory_status auth=none cut=timeout cold id=slow-1$/
      ),
    ]);
  });

  it("logs each scheduled event's outcome and duration, and still fails a failed dream", async () => {
    const { lines, log } = capture();
    const ynm = memoryYnm();
    const handler = createLambdaHandler({
      env: lambdaEnv(),
      quiet: true,
      log,
      getYnm: async () => ynm,
    });
    await handler({ ynm: "dream" }, { awsRequestId: "d-1" });
    await handler({ ynm: "health" }, { awsRequestId: "h-1" });
    expect(lines.filter((l) => l.includes("scheduled"))).toEqual([
      expect.stringMatching(/^info \[ynm-mcp lambda\] scheduled dream ok \d+ms cold id=d-1$/),
      expect.stringMatching(/^info \[ynm-mcp lambda\] scheduled health ok \d+ms id=h-1$/),
    ]);
    const failed = capture();
    const failing = createLambdaHandler({
      env: lambdaEnv(),
      quiet: true,
      log: failed.log,
      getYnm: async () => {
        throw new Error("store offline");
      },
    });
    await expect(failing({ ynm: "dream" }, { awsRequestId: "d-2" })).rejects.toThrow(
      /store offline/
    );
    expect(failed.lines.filter((l) => l.includes("scheduled"))).toEqual([
      expect.stringMatching(
        /^error \[ynm-mcp lambda\] scheduled dream failed \d+ms cold id=d-2: dream: store offline$/
      ),
    ]);
  });

  it("a log sink that throws never fails a request or an event", async () => {
    const handler = createLambdaHandler({
      env: lambdaEnv(),
      getYnm: async () => memoryYnm(),
      quiet: true,
      log: () => {
        throw new Error("sink broke");
      },
    });
    const health = (await handler(event({ rawPath: "/health" }))) as FunctionUrlResult;
    expect(health.statusCode).toBe(200);
    expect(await handler({ ynm: "health" })).toMatchObject({ status: "ok" });
  });
});
