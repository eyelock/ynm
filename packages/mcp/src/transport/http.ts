import { createServer as createHttpServer, type Server as NodeServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  type McpServer,
  type OAuthTokenVerifier,
  originValidationResponse,
  verifyBearerToken,
} from "@modelcontextprotocol/server";

export interface HttpOptions {
  port?: number;
  host?: string;
  /** Static bearer token (dev and tests). Prefer `verifier` for anything else. */
  authToken?: string;
  /** Token verifier (static, OAuth introspection or JWT via JWKS); see auth.ts. */
  verifier?: OAuthTokenVerifier;
  requiredScopes?: string[];
  /** Origins allowed by CORS and origin validation; localhost only by default. */
  allowedOrigins?: string[];
  allowedHosts?: string[];
  rejectLegacy?: boolean;
  /** Extra fields for /health (scheduler stats in hosted mode). */
  health?: () => Record<string, unknown>;
  /** Log to stderr; off in tests. */
  quiet?: boolean;
}

export interface HttpHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
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
 * Streamable HTTP, protocol 2026-07-28 with the SDK's legacy fallback. Copied in spirit from
 * mcp-toolkit: a fresh server per request (stateless, NFR-11), host and origin validation in
 * front of the handler, localhost CORS, optional bearer, /health outside auth.
 */
export async function startHttp(
  factory: () => McpServer,
  options: HttpOptions = {}
): Promise<HttpHandle> {
  const {
    port = 3000,
    host = "localhost",
    authToken,
    rejectLegacy = false,
    quiet = false,
  } = options;
  const origins = options.allowedOrigins ?? localhostAllowedOrigins();
  const hosts = options.allowedHosts ?? localhostAllowedHostnames();
  const handler = createMcpHandler(() => factory(), {
    legacy: rejectLegacy ? "reject" : "stateless",
    onerror: (error) => {
      if (!quiet) console.error(`[ynm-mcp] ${error.message}`);
    },
  });
  const mcp = toNodeHandler(handler);

  const httpServer: NodeServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", name: "ynm", ...(options.health?.() ?? {}) }));
      return;
    }
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id"
    );
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const probe = new Request(url, { method: req.method, headers: toHeaders(req.headers) });
    const rejected =
      (hosts.includes("*") ? null : hostHeaderValidationResponse(probe, hosts)) ??
      originValidationResponse(probe, origins);
    if (rejected) {
      res.writeHead(rejected.status, { "Content-Type": "application/json" });
      res.end(await rejected.text());
      return;
    }
    let authInfo: AuthInfo | undefined;
    if (options.verifier) {
      try {
        authInfo = await verifyBearerToken(req.headers.authorization, {
          verifier: options.verifier,
          requiredScopes: options.requiredScopes,
        });
      } catch (err) {
        const challenge = bearerAuthChallengeResponse(err, {
          requiredScopes: options.requiredScopes,
        });
        res.writeHead(challenge.status, Object.fromEntries(challenge.headers.entries()));
        res.end(await challenge.text());
        return;
      }
    } else if (authToken && req.headers.authorization !== `Bearer ${authToken}`) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="ynm"',
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    (req as typeof req & { auth?: AuthInfo }).auth = authInfo;
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
      await handler.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
