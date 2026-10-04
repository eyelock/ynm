/**
 * One log line per HTTP request, shared by the Lambda entry and `ynm serve --http`:
 *
 *   request POST /mcp 200 143ms rpc=tools/call tool=memory_recall auth=static id=<request id>
 *
 * Method, path, status and duration come first and always; the rest are `key=value` fields that
 * appear only when known. It never carries a token, a header value, a query string, or anything
 * from a request or response body beyond the JSON-RPC method and tool name, each checked against
 * a short pattern so free text can never reach the log.
 */
import type { AuthInfo } from "@modelcontextprotocol/server";
import { isStaticToken } from "../auth.js";
import { loginOf } from "../identity.js";

/**
 * Who a request came as: a shared static token, a signed-in person, a verified token that names
 * no person, nobody (auth off), refused by the front door, or public (health, discovery,
 * preflight: answered before auth).
 */
export type AuthKind = "static" | "signed-in" | "token" | "none" | "refused" | "public";

/** What the front door decided about one request, for its log line. */
export interface RequestSeen {
  auth?: AuthKind;
  /** The OAuth client id of a verified, non-static token. */
  client?: string;
}

export interface RequestLogEntry extends RequestSeen {
  method: string;
  path: string;
  status: number;
  ms: number;
  /** JSON-RPC method names in the request (a legacy batch can carry several). */
  rpc?: string[];
  /** The tool a `tools/call` names. */
  tool?: string;
  /** Lambda request id. */
  id?: string;
  /** The first invocation this instance served (a request or a scheduled run). */
  cold?: boolean;
  /**
   * The response was not delivered whole: cut off near the function's timeout, near the API
   * gateway's (which also counts the time before the handler ran), or the client went away.
   */
  cut?: "timeout" | "gateway" | "client";
  /** Milliseconds between the gateway receiving the request and the handler starting on it. */
  waited?: number;
}

export type LogLevel = "info" | "error";
/** Where log lines go; a sink must not throw, but callers guard it anyway. */
export type LogSink = (level: LogLevel, line: string) => void;

/** A name safe to log: JSON-RPC methods, tool names, client ids. Anything else is `?`. */
const NAME = /^[\w./:@-]{1,64}$/;
const safeName = (s: unknown): string | undefined =>
  typeof s === "string" ? (NAME.test(s) ? s : "?") : undefined;

/** A path with no query, without whitespace or control characters, and capped. */
function safePath(path: string): string {
  const p = path.split("?")[0] ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is stripped
  const clean = p.replace(/[\s\u0000-\u001f\u007f]+/g, "_");
  return (clean || "/").slice(0, 200);
}

export function formatRequestLine(e: RequestLogEntry): string {
  const parts = [
    "request",
    safeName(e.method.toUpperCase()) ?? "?",
    safePath(e.path),
    String(e.status),
    `${Math.max(0, Math.round(e.ms))}ms`,
  ];
  if (e.rpc?.length) {
    const shown = e.rpc.slice(0, 5).map((m) => safeName(m) ?? "?");
    parts.push(`rpc=${shown.join(",")}${e.rpc.length > 5 ? `,+${e.rpc.length - 5}` : ""}`);
  }
  if (e.tool) parts.push(`tool=${safeName(e.tool) ?? "?"}`);
  if (e.auth) parts.push(`auth=${e.auth}`);
  if (e.client) parts.push(`client=${safeName(e.client) ?? "?"}`);
  if (e.cut) parts.push(`cut=${e.cut}`);
  if (e.waited !== undefined) parts.push(`waited=${Math.max(0, Math.round(e.waited))}ms`);
  if (e.cold) parts.push("cold");
  if (e.id) parts.push(`id=${safeName(e.id) ?? "?"}`);
  return parts.join(" ");
}

/** A 5xx, or a response that was cut short, is logged as an error; the rest as info. */
export const levelFor = (e: Pick<RequestLogEntry, "status" | "cut">): LogLevel =>
  e.status >= 500 || e.cut ? "error" : "info";

/**
 * The auth kind and client of a request the front door let through; `verified` says whether the
 * front door checks tokens at all.
 */
export function seenFor(info: AuthInfo | undefined, verified: boolean): RequestSeen {
  if (!verified) return { auth: "none" };
  // A bare `authToken` (no verifier) passes a request with no auth info: a static token.
  if (!info || isStaticToken(info)) return { auth: "static" };
  return { auth: loginOf(info) ? "signed-in" : "token", client: info.clientId || undefined };
}

/** The auth kind of a request the front door answered itself. */
export const seenForAnswer = (status: number): RequestSeen => ({
  auth: status === 401 || status === 403 ? "refused" : "public",
});

export interface RpcSummary {
  rpc?: string[];
  tool?: string;
}

/** The method and tool from the standard `Mcp-Method` and `Mcp-Name` request headers. */
export function rpcFromHeaders(headers: Headers): RpcSummary {
  const method = headers.get("mcp-method")?.trim();
  if (!method) return {};
  const name = headers.get("mcp-name")?.trim();
  return { rpc: [method], ...(method === "tools/call" && name ? { tool: name } : {}) };
}

/** Bodies larger than this are not parsed for the log line. */
const MAX_PARSE = 1024 * 1024;

/**
 * The JSON-RPC method(s) and the tool name from a request body. Only those two fields are read;
 * anything that is not a JSON-RPC message, or too large to be worth parsing, gives nothing.
 */
export function rpcFromBody(body: string | undefined): RpcSummary {
  if (!body || body.length > MAX_PARSE) return {};
  const first = body.trimStart()[0];
  if (first !== "{" && first !== "[") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  const messages = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
    method?: unknown;
    params?: { name?: unknown };
  }>;
  const rpc: string[] = [];
  let tool: string | undefined;
  for (const m of messages) {
    if (typeof m !== "object" || m === null || typeof m.method !== "string") continue;
    rpc.push(m.method);
    if (m.method === "tools/call" && tool === undefined && typeof m.params?.name === "string")
      tool = m.params.name;
  }
  return rpc.length ? { rpc, ...(tool ? { tool } : {}) } : {};
}

/** The console as a sink: info to stdout, errors to stderr. */
export const consoleSink: LogSink = (level, line) => {
  if (level === "error") console.error(line);
  else console.info(line);
};
