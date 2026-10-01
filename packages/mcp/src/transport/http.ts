import { createServer as createHttpServer, type Server as NodeServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  type McpHttpHandler,
  type McpServer,
  type OAuthTokenVerifier,
  originValidationResponse,
  verifyBearerToken,
} from "@modelcontextprotocol/server";

/** What sits in front of the MCP handler: health, CORS, host and origin checks, auth. */
export interface FrontDoorOptions {
  /** Static bearer token (dev and tests). Prefer `verifier` for anything else. */
  authToken?: string;
  /** Token verifier (static, OAuth introspection or JWT via JWKS); see auth.ts. */
  verifier?: OAuthTokenVerifier;
  requiredScopes?: string[];
  /** Origins allowed by CORS and origin validation; localhost only by default. */
  allowedOrigins?: string[];
  allowedHosts?: string[];
  /** Extra fields for /health (scheduler stats in hosted mode). */
  health?: () => Record<string, unknown>;
}

export interface WebHandlerOptions extends FrontDoorOptions {
  rejectLegacy?: boolean;
  /** Log to stderr; off in tests. */
  quiet?: boolean;
}

export interface HttpOptions extends WebHandlerOptions {
  port?: number;
  host?: string;
}

export interface HttpHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * The front door's verdict on one request: either an answer of its own (health, a preflight, a
 * rejection or an auth challenge), or permission to pass to the MCP handler with the verified
 * caller and the CORS headers to add to whatever the handler answers.
 */
export type FrontDoorResult = { response: Response } | { authInfo?: AuthInfo; cors: Headers };

const json = (status: number, body: string, headers: Headers): Response => {
  headers.set("Content-Type", "application/json");
  return new Response(body, { status, headers });
};

/**
 * Health outside auth, localhost CORS, host and origin validation, then the bearer check. Web
 * standard, so the Node server and the Lambda entry run the same checks in the same order.
 */
export function createFrontDoor(
  options: FrontDoorOptions = {}
): (request: Request) => Promise<FrontDoorResult> {
  const origins = options.allowedOrigins ?? localhostAllowedOrigins();
  const hosts = options.allowedHosts ?? localhostAllowedHostnames();
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      const body = JSON.stringify({ status: "ok", name: "ynm", ...(options.health?.() ?? {}) });
      return { response: json(200, body, new Headers()) };
    }
    const cors = new Headers();
    const origin = request.headers.get("origin");
    if (origin && origins.includes(origin)) {
      cors.set("Access-Control-Allow-Origin", origin);
      cors.set("Vary", "Origin");
    }
    cors.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    cors.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id"
    );
    if (request.method === "OPTIONS")
      return { response: new Response(null, { status: 204, headers: cors }) };
    const rejected =
      (hosts.includes("*") ? null : hostHeaderValidationResponse(request, hosts)) ??
      originValidationResponse(request, origins);
    if (rejected) return { response: json(rejected.status, await rejected.text(), cors) };
    const authorization = request.headers.get("authorization") ?? undefined;
    if (options.verifier) {
      try {
        const authInfo = await verifyBearerToken(authorization, {
          verifier: options.verifier,
          requiredScopes: options.requiredScopes,
        });
        return { authInfo, cors };
      } catch (err) {
        const challenge = bearerAuthChallengeResponse(err, {
          requiredScopes: options.requiredScopes,
        });
        const headers = new Headers(cors);
        for (const [k, v] of challenge.headers) headers.set(k, v);
        return {
          response: new Response(await challenge.text(), { status: challenge.status, headers }),
        };
      }
    }
    if (options.authToken && authorization !== `Bearer ${options.authToken}`) {
      cors.set("WWW-Authenticate", 'Bearer realm="ynm"');
      return { response: json(401, JSON.stringify({ error: "Unauthorized" }), cors) };
    }
    return { cors };
  };
}

export interface WebHandler {
  /** Serves one request: the front door, then a fresh MCP server for it. */
  fetch: (request: Request) => Promise<Response>;
  /** The checks in front of the MCP handler. */
  frontDoor: (request: Request) => Promise<FrontDoorResult>;
  /** The MCP handler behind the front door (the Node server adapts it to node:http). */
  mcp: McpHttpHandler;
  close: () => Promise<void>;
}

/** Responses that must not carry a body, whatever the handler built. */
const NULL_BODY = new Set([101, 204, 205, 304]);

/**
 * Streamable HTTP, protocol 2026-07-28 with the SDK's legacy fallback, as one web-standard
 * `(Request) => Promise<Response>`. Copied in spirit from mcp-toolkit: a fresh server per
 * request (stateless, NFR-11), host and origin validation in front of the handler, localhost
 * CORS, optional bearer, /health outside auth.
 */
export function createWebHandler(
  factory: () => McpServer,
  options: WebHandlerOptions = {}
): WebHandler {
  const { rejectLegacy = false, quiet = false } = options;
  const mcp = createMcpHandler(() => factory(), {
    legacy: rejectLegacy ? "reject" : "stateless",
    onerror: (error) => {
      if (!quiet) console.error(`[ynm-mcp] ${error.message}`);
    },
  });
  const door = createFrontDoor(options);
  return {
    frontDoor: door,
    mcp,
    close: () => mcp.close(),
    fetch: async (request) => {
      const verdict = await door(request);
      if ("response" in verdict) return verdict.response;
      const res = await mcp.fetch(request, { authInfo: verdict.authInfo });
      const headers = new Headers(res.headers);
      for (const [k, v] of verdict.cors) if (!headers.has(k)) headers.set(k, v);
      return new Response(NULL_BODY.has(res.status) ? null : res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    },
  };
}

function toHeaders(raw: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value !== undefined) headers.set(key, value);
  }
  return headers;
}

/**
 * The web handler on node:http. The front door sees a body-less copy of the request; the MCP
 * leg runs through the SDK's Node adapter so responses stream as before.
 */
export async function startHttp(
  factory: () => McpServer,
  options: HttpOptions = {}
): Promise<HttpHandle> {
  const { port = 3000, host = "localhost", quiet = false } = options;
  const web = createWebHandler(factory, options);
  const door = web.frontDoor;
  const mcp = toNodeHandler(web.mcp);

  const httpServer: NodeServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    const probe = new Request(url, { method: req.method, headers: toHeaders(req.headers) });
    const verdict = await door(probe);
    if ("response" in verdict) {
      const { response } = verdict;
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(await response.text());
      return;
    }
    for (const [k, v] of verdict.cors) res.setHeader(k, v);
    (req as typeof req & { auth?: AuthInfo }).auth = verdict.authInfo;
    await mcp(req, res);
  });

  const bound = await new Promise<number>((resolve) => {
    httpServer.listen(port, host, () => {
      const address = httpServer.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
  const url = `http://${host}:${bound}/mcp`;
  if (!quiet) console.error(`ynm-mcp listening on ${url} (health: http://${host}:${bound}/health)`);
  return {
    port: bound,
    url,
    close: async () => {
      await web.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
