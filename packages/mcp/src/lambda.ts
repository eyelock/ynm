/**
 * @ynm/mcp on AWS Lambda: `handler(event, context)` serves Function URL requests (payload format
 * 2.0) through the same front door and MCP handler as the Node server, and runs scheduled work
 * sent by EventBridge Scheduler as `{ "ynm": "dream" | "compact" | "health" }`.
 *
 * Configuration comes from the environment alone. `YNM_PUBLIC_URL` is required: the Host the
 * function sees is AWS's, not the one clients use. The service is opened once per instance, with
 * its index under `YNM_HOME` (default `/tmp/ynm`); the personal mount is never opened.
 */
import { mkdirSync } from "node:fs";
import type { Ynm } from "@ynm/service";
import type { RecordLog, ShardKey } from "@ynm/store";
import { authFromEnv, protectedResourceFor, verifierFor } from "./auth.js";
import { hostedAudit } from "./identity.js";
import { startScheduler } from "./scheduler.js";
import { createYnmServer, serviceCache } from "./server.js";
import { createWebHandler } from "./transport/http.js";
import { MCP_VERSION } from "./version.js";

/** A Lambda Function URL request, payload format 2.0 (the fields ynm reads). */
export interface FunctionUrlEvent {
  version?: string;
  rawPath: string;
  rawQueryString?: string;
  /** Lower-cased names; repeated headers arrive comma-joined. */
  headers?: Record<string, string | undefined>;
  /** Cookie headers arrive here, not in `headers`. */
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string }; domainName?: string };
}

/** A Function URL response, payload format 2.0. */
export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded: boolean;
}

export const SCHEDULED_TASKS = ["dream", "compact", "health"] as const;
export type ScheduledTask = (typeof SCHEDULED_TASKS)[number];

/** What an EventBridge Scheduler target sends: its JSON input, as is. */
export interface ScheduledEvent {
  ynm: ScheduledTask;
}

export interface ScheduledResult {
  ynm: ScheduledTask;
  status: "ok";
  [key: string]: unknown;
}

/** The part of the Lambda context ynm uses. */
export interface LambdaContext {
  getRemainingTimeInMillis?: () => number;
}

export type LambdaHandler = (
  event: unknown,
  context?: LambdaContext
) => Promise<FunctionUrlResult | ScheduledResult>;

export function isFunctionUrlEvent(event: unknown): event is FunctionUrlEvent {
  const e = event as Partial<FunctionUrlEvent> | null;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.rawPath === "string" &&
    typeof e.requestContext?.http?.method === "string"
  );
}

export function isScheduledEvent(event: unknown): event is { ynm: unknown } {
  return typeof event === "object" && event !== null && "ynm" in event;
}

/**
 * A Function URL event as a web `Request`. The URL and Host are the public ones (`publicUrl`),
 * because the function is reached through AWS's own host name, often behind a CDN.
 */
export function toRequest(event: FunctionUrlEvent, publicUrl: URL): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {}))
    if (value !== undefined) headers.set(name, value);
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
  headers.set("host", publicUrl.host);
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = new URL(`${publicUrl.origin}${event.rawPath || "/"}${query}`);
  const method = event.requestContext.http.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && event.body !== undefined;
  return new Request(url, {
    method,
    headers,
    body: hasBody
      ? event.isBase64Encoded
        ? Buffer.from(event.body as string, "base64")
        : (event.body as string)
      : undefined,
  });
}

const TEXTUAL =
  /^(text\/|application\/(json|[\w.+-]+\+json|javascript|xml|[\w.+-]+\+xml|x-www-form-urlencoded))/i;

/**
 * Reads a body to the end, or until `timeoutMs` passes: a stream that never ends (a
 * notification stream) is cut off with what it had sent, rather than running the function out.
 */
async function readBody(res: Response, timeoutMs?: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  for (;;) {
    let timer: NodeJS.Timeout | undefined;
    const timeout =
      deadline === undefined
        ? undefined
        : new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
          });
    const next = await (timeout ? Promise.race([reader.read(), timeout]) : reader.read());
    clearTimeout(timer);
    if (next === null) {
      await reader.cancel().catch(() => {});
      break;
    }
    if (next.done) break;
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

/** A web `Response` as a buffered Function URL result; binary bodies go base64. */
export async function toResult(
  res: Response,
  opts: { timeoutMs?: number } = {}
): Promise<FunctionUrlResult> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = res.headers.getSetCookie();
  const bytes = await readBody(res, opts.timeoutMs);
  const textual = bytes.length === 0 || TEXTUAL.test(res.headers.get("content-type") ?? "");
  return {
    statusCode: res.status,
    headers,
    ...(cookies.length ? { cookies } : {}),
    body: textual ? bytes.toString("utf8") : bytes.toString("base64"),
    isBase64Encoded: !textual,
  };
}

export interface LambdaConfig {
  publicUrl: URL;
  /** The environment the service is opened with: the given one plus Lambda defaults. */
  env: NodeJS.ProcessEnv;
  home: string;
}

/** Reads and checks the function's environment; throws with what to set when it is unusable. */
export function lambdaConfig(env: NodeJS.ProcessEnv = process.env): LambdaConfig {
  const raw = env.YNM_PUBLIC_URL?.trim();
  if (!raw)
    throw new Error(
      "YNM_PUBLIC_URL is not set. Set it to the URL clients use to reach this function, e.g. https://memory.example.com/mcp"
    );
  let publicUrl: URL;
  try {
    publicUrl = new URL(raw);
  } catch {
    throw new Error(`YNM_PUBLIC_URL is not a URL: "${raw}"`);
  }
  if (publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:")
    throw new Error(`YNM_PUBLIC_URL must be an http or https URL: "${raw}"`);
  const home = env.YNM_HOME || "/tmp/ynm";
  return {
    publicUrl,
    home,
    env: { ...env, YNM_HOME: home, YNM_NO_CLAUDE_CLI: env.YNM_NO_CLAUDE_CLI ?? "1" },
  };
}

type Compactable = RecordLog & {
  compact?: (shard: ShardKey, opts?: Record<string, unknown>) => Promise<unknown>;
};

/** Runs each mount's provider compaction over its shards, where the provider has one. */
export async function compactMounts(ynm: Ynm): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const mount of ynm.mounts) {
    const log = mount.log as Compactable;
    if (typeof log.compact !== "function") {
      out.push({
        mount: mount.id,
        provider: log.provider,
        compacted: false,
        reason: `the ${log.provider} provider has no compaction; nothing to do`,
      });
      continue;
    }
    const shards = await log.shards();
    const results: unknown[] = [];
    for (const s of shards)
      results.push(
        await log.compact({
          level: s.level,
          namespace: s.namespace,
          type: s.type,
          bucket: s.bucket,
        })
      );
    out.push({
      mount: mount.id,
      provider: log.provider,
      compacted: true,
      shards: shards.length,
      results,
    });
  }
  return out;
}

export interface LambdaHandlerOptions {
  env?: NodeJS.ProcessEnv;
  /** Replaces the service opened from the environment (tests). */
  getYnm?: () => Promise<Ynm>;
  /** No logging to stderr (tests). */
  quiet?: boolean;
}

/**
 * Builds the handler for one Lambda instance: configuration is checked now, the service is
 * opened on first use and kept for the instance's life, and each request gets a fresh MCP server.
 */
export function createLambdaHandler(opts: LambdaHandlerOptions = {}): LambdaHandler {
  const cfg = lambdaConfig(opts.env ?? process.env);
  mkdirSync(cfg.home, { recursive: true });
  const serverOpts = { cwd: cfg.home, env: cfg.env, noPersonal: true };
  let opened = false;
  const open = opts.getYnm ?? serviceCache(serverOpts);
  const getYnm = async () => {
    const ynm = await open();
    opened = true;
    return ynm;
  };
  const auth = authFromEnv(cfg.env);
  // A function is reachable from the internet by design, so it never runs open by accident.
  if (auth.mode === "none" && cfg.env.YNM_LAMBDA_ALLOW_OPEN !== "1") {
    throw new Error(
      "No authentication is configured, and a function is public. Set YNM_JWKS_URL, YNM_OAUTH_INTROSPECTION_URL or YNM_MCP_TOKEN (directly or through YNM_SSM_ENV_PATH); YNM_LAMBDA_ALLOW_OPEN=1 serves without auth, for local tests only"
    );
  }
  const requiredScopes = cfg.env.YNM_REQUIRED_SCOPES?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const scheduler = startScheduler(getYnm, { quiet: opts.quiet });
  const audited = hostedAudit(cfg.env, auth.mode !== "none", getYnm);
  const web = createWebHandler(
    () => createYnmServer({ ...serverOpts, version: MCP_VERSION }, getYnm),
    {
      verifier: verifierFor(auth),
      requiredScopes,
      protectedResource: protectedResourceFor(auth, cfg.env, requiredScopes),
      allowedHosts: [cfg.publicUrl.hostname],
      health: () => ({ auth: auth.mode, runtime: "lambda", scheduler: scheduler.stats }),
      quiet: opts.quiet,
      ...audited,
    }
  );
  const log = (msg: string) => {
    if (!opts.quiet) console.error(`[ynm-mcp lambda] ${msg}`);
  };
  if (!opts.quiet) console.error(`ynm-mcp auth: ${auth.mode}`);

  const scheduled = async (task: unknown): Promise<ScheduledResult> => {
    switch (task) {
      case "health": {
        const warm = opened;
        await getYnm();
        return { ynm: "health", status: "ok", name: "ynm", version: MCP_VERSION, warm };
      }
      case "dream": {
        const before = scheduler.stats.dreamRuns;
        await scheduler.dreamNow();
        if (scheduler.stats.dreamRuns === before)
          throw new Error(scheduler.stats.lastError ?? "dream: the run did not complete");
        return { ynm: "dream", status: "ok", passes: scheduler.stats.lastDream };
      }
      case "compact": {
        const mounts = await compactMounts(await getYnm());
        log(`compact: ${JSON.stringify(mounts.map(({ results: _, ...m }) => m))}`);
        return { ynm: "compact", status: "ok", mounts };
      }
      default:
        throw new Error(
          `unknown scheduled task ${JSON.stringify(task)}; expected one of ${SCHEDULED_TASKS.join(", ")}`
        );
    }
  };

  return async (event, context) => {
    if (isScheduledEvent(event)) return scheduled(event.ynm);
    if (!isFunctionUrlEvent(event))
      throw new Error(
        'unrecognised event: expected a Function URL request (payload format 2.0) or { "ynm": "dream" | "compact" | "health" }'
      );
    const remaining = context?.getRemainingTimeInMillis?.();
    try {
      const response = await web.fetch(toRequest(event, cfg.publicUrl));
      return await toResult(response, {
        timeoutMs: remaining === undefined ? undefined : Math.max(0, remaining - 1000),
      });
    } catch (err) {
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        statusCode: 500,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "internal error" }),
        isBase64Encoded: false,
      };
    }
  };
}

// Inside Lambda the instance is built during init, so a missing setting fails the cold start
// with its message; elsewhere (tests, the bundle smoke test) on first call.
let instance: LambdaHandler | undefined = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? createLambdaHandler()
  : undefined;

/** The Lambda entry point. */
export async function handler(
  event: unknown,
  context?: LambdaContext
): Promise<FunctionUrlResult | ScheduledResult> {
  instance ??= createLambdaHandler();
  return instance(event, context);
}
