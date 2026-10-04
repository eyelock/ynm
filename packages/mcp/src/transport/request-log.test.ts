import { STATIC_TOKEN_EXTRA } from "../auth.js";
import {
  formatRequestLine,
  levelFor,
  rpcFromBody,
  rpcFromHeaders,
  seenFor,
  seenForAnswer,
} from "./request-log.js";

describe("request log line", () => {
  it("puts method, path, status and duration first, then only the fields that apply", () => {
    expect(formatRequestLine({ method: "get", path: "/health", status: 200, ms: 3.4 })).toBe(
      "request GET /health 200 3ms"
    );
    expect(
      formatRequestLine({
        method: "POST",
        path: "/mcp",
        status: 200,
        ms: 143,
        rpc: ["tools/call"],
        tool: "memory_recall",
        auth: "signed-in",
        client: "claude-code",
        cut: "timeout",
        cold: true,
        id: "abc-123",
      })
    ).toBe(
      "request POST /mcp 200 143ms rpc=tools/call tool=memory_recall auth=signed-in client=claude-code cut=timeout cold id=abc-123"
    );
  });

  it("never lets free text, a query string or control characters through", () => {
    const line = formatRequestLine({
      method: "POST",
      path: "/mcp?token=hush\nforged line",
      status: 500,
      ms: -5,
      rpc: ["tools/call", "has space", "a", "b", "c", "d", "e"],
      tool: "memory recall with words",
      client: "client\nid",
      id: "id with space",
    });
    expect(line).toBe("request POST /mcp 500 0ms rpc=tools/call,?,a,b,c,+2 tool=? client=? id=?");
    expect(formatRequestLine({ method: "GET", path: "/a b\tc", status: 404, ms: 1 })).toBe(
      "request GET /a_b_c 404 1ms"
    );
    expect(formatRequestLine({ method: "GET", path: "", status: 404, ms: 1 })).toBe(
      "request GET / 404 1ms"
    );
  });

  it("logs a 5xx or a cut response as an error", () => {
    expect(levelFor({ status: 200 })).toBe("info");
    expect(levelFor({ status: 401 })).toBe("info");
    expect(levelFor({ status: 502 })).toBe("error");
    expect(levelFor({ status: 200, cut: "timeout" })).toBe("error");
  });
});

describe("JSON-RPC method and tool", () => {
  it("reads the standard headers, with the tool only for tools/call", () => {
    expect(
      rpcFromHeaders(new Headers({ "mcp-method": "tools/call", "mcp-name": "memory_context" }))
    ).toEqual({ rpc: ["tools/call"], tool: "memory_context" });
    expect(
      rpcFromHeaders(new Headers({ "mcp-method": "resources/read", "mcp-name": "ynm://x" }))
    ).toEqual({ rpc: ["resources/read"] });
    expect(rpcFromHeaders(new Headers())).toEqual({});
  });

  it("reads a body's method and tool, a batch's methods, and nothing from anything else", () => {
    expect(
      rpcFromBody(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "t" } })
      )
    ).toEqual({ rpc: ["tools/call"], tool: "t" });
    expect(
      rpcFromBody(
        JSON.stringify([
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "first" } },
          { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "second" } },
          null,
          { jsonrpc: "2.0", id: 4, result: {} },
        ])
      )
    ).toEqual({ rpc: ["notifications/initialized", "tools/call", "tools/call"], tool: "first" });
    for (const body of [undefined, "", "not json", "{broken", "[]", '{"id":1}', "42"])
      expect(rpcFromBody(body)).toEqual({});
    const huge = JSON.stringify({ method: "tools/call", pad: "x".repeat(1024 * 1024) });
    expect(rpcFromBody(huge)).toEqual({});
  });
});

describe("auth kind", () => {
  it("tells a static token, a signed-in person, a bare token, no auth and front-door answers apart", () => {
    expect(seenFor(undefined, false)).toEqual({ auth: "none" });
    expect(seenFor(undefined, true)).toEqual({ auth: "static" });
    const base = { token: "t", clientId: "c", scopes: [] };
    expect(seenFor({ ...base, extra: { [STATIC_TOKEN_EXTRA]: true } }, true)).toEqual({
      auth: "static",
    });
    expect(seenFor({ ...base, extra: { sub: "u1", iss: "https://idp" } }, true)).toEqual({
      auth: "signed-in",
      client: "c",
    });
    expect(seenFor({ ...base, clientId: "" }, true)).toEqual({ auth: "token" });
    expect(seenForAnswer(401)).toEqual({ auth: "refused" });
    expect(seenForAnswer(403)).toEqual({ auth: "refused" });
    expect(seenForAnswer(200)).toEqual({ auth: "public" });
  });
});
