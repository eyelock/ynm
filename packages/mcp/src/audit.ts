import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { ulid } from "@ynm/model";
import { loadStoreS3 } from "@ynm/service";
import { z } from "zod";

/*
 * The audit log (ADR-017): one event per HTTP request, metadata only. An event names who asked
 * (a ynm person id, never an email or IdP subject), which tools ran and how big their arguments
 * were, but never memory content, query text or tool inputs, so the log is safe to keep longer
 * and share more widely than the store itself.
 */

/** One tool call or resource read made while serving a request. */
export interface AuditCall {
  /** MCP tool name, or `resource:<template>` for resource reads. */
  tool: string;
  status: "ok" | "error";
  /** Ids of the memories written or returned. */
  memoryIds?: string[];
  /** Size of the tool arguments as JSON, never the arguments themselves. */
  inputBytes?: number;
  /** For example the number of recall hits. */
  resultCount?: number;
}

export interface AuditEvent {
  /** ISO time the request arrived. */
  at: string;
  id: string;
  /** ynm person id; absent when the request carried no identity. */
  person?: string;
  /** OAuth client id. */
  client?: string;
  method: string;
  /** URL path only; a query string could carry anything. */
  path: string;
  /** HTTP status returned. */
  status: number;
  /** `refused` is a 401 or 403; `error` any other 4xx or 5xx. */
  outcome: "ok" | "refused" | "error";
  /** For refusals: the error code (`invalid_token`, `insufficient_scope`), never the token. */
  reason?: string;
  calls: AuditCall[];
  durationMs: number;
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}

/** What the request handler knows once it has answered. */
export interface AuditResponse {
  status: number;
  person?: string;
  client?: string;
  reason?: string;
}

/** Size of a value as JSON in bytes, for `AuditCall.inputBytes`. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null) ?? "", "utf8");
}

// The calls of the request in flight, so tool callbacks deep in the SDK can add to them without
// the request object being threaded through.
const current = new AsyncLocalStorage<AuditCall[]>();

/** Runs `fn` as one audited request; calls recorded anywhere inside it are collected. */
export async function runAudited<T>(
  fn: () => Promise<T>
): Promise<{ result: T; calls: AuditCall[] }> {
  const calls: AuditCall[] = [];
  const result = await current.run(calls, fn);
  return { result, calls };
}

/** Adds a call to the request in flight; a no-op outside one (stdio, tests, the scheduler). */
export function recordCall(call: AuditCall): void {
  current.getStore()?.push(call);
}

function outcomeOf(status: number): AuditEvent["outcome"] {
  if (status === 401 || status === 403) return "refused";
  return status >= 400 ? "error" : "ok";
}

function pathOf(url: string): string {
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return url.split(/[?#]/, 1)[0] ?? "";
  }
}

export interface AuditorOptions {
  now?: () => Date;
  /** Where sink failures go; defaults to stderr. */
  onError?: (err: unknown) => void;
}

/** Wraps each request: times it, collects its calls and writes one event to the sink. */
export class Auditor {
  private readonly now: () => Date;
  private readonly onError: (err: unknown) => void;

  constructor(
    private readonly sink: AuditSink,
    opts: AuditorOptions = {}
  ) {
    this.now = opts.now ?? (() => new Date());
    this.onError =
      opts.onError ?? ((err) => console.error("[ynm-mcp audit] could not write an event:", err));
  }

  /**
   * Runs `handle` and audits it. The event is written before this resolves, because on a function
   * work after the response may never run; a sink failure is reported to `onError` and never
   * reaches the caller. When `handle` throws, a 500 event is written and the error rethrown.
   */
  async around<R extends AuditResponse>(
    req: { method: string; url: string },
    handle: () => Promise<R>
  ): Promise<R> {
    const start = this.now();
    const calls: AuditCall[] = [];
    let response: AuditResponse;
    let result: R;
    try {
      result = await current.run(calls, handle);
      response = result;
    } catch (err) {
      await this.emit(req, start, calls, { status: 500 });
      throw err;
    }
    await this.emit(req, start, calls, response);
    return result;
  }

  private async emit(
    req: { method: string; url: string },
    start: Date,
    calls: AuditCall[],
    res: AuditResponse
  ): Promise<void> {
    const outcome = outcomeOf(res.status);
    const event: AuditEvent = {
      at: start.toISOString(),
      id: ulid(start.getTime()),
      ...(res.person ? { person: res.person } : {}),
      ...(res.client ? { client: res.client } : {}),
      method: req.method,
      path: pathOf(req.url),
      status: res.status,
      outcome,
      ...(outcome === "refused" && res.reason ? { reason: res.reason } : {}),
      calls,
      durationMs: Math.max(0, this.now().getTime() - start.getTime()),
    };
    try {
      await this.sink.write(event);
    } catch (err) {
      this.onError(err);
    }
  }
}

/** One JSON line per event on stdout, so a function's log group holds each as its own entry. */
export function stdoutSink(): AuditSink {
  return {
    write: (event) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(`${JSON.stringify(event)}\n`, (err) =>
          err ? reject(err) : resolve()
        );
      }),
  };
}

export const DEFAULT_AUDIT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * JSONL appended to `path`. Once the file reaches `maxBytes` it is renamed to `<path>.1`
 * (replacing the previous one) before the next append. Writes are queued so rotation never races
 * within one process; several processes should each have their own file.
 */
export function fileSink(path: string, opts: { maxBytes?: number } = {}): AuditSink {
  const maxBytes = opts.maxBytes ?? DEFAULT_AUDIT_MAX_BYTES;
  let queue: Promise<void> = Promise.resolve();
  const append = async (line: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const size = await stat(path).then(
      (s) => s.size,
      () => 0
    );
    if (size >= maxBytes) await rename(path, `${path}.1`);
    await appendFile(path, line, "utf8");
  };
  return {
    write(event) {
      const next = queue.then(() => append(`${JSON.stringify(event)}\n`));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

const SINKS = ["stdout", "file", "s3", "off"] as const;

const AuditConfig = z.strictObject({
  sink: z.enum(SINKS),
  path: z.string().min(1).optional(),
  bucket: z.string().min(1).optional(),
  prefix: z.string().optional(),
  region: z.string().min(1).optional(),
});

export type AuditConfig = z.infer<typeof AuditConfig>;

export interface AuditDefaults {
  /** The server checks tokens; audit is then on (stdout) unless configured otherwise. */
  authenticated: boolean;
  /** The store's own bucket and prefix, when it is on S3. */
  s3Store?: { bucket: string; prefix: string; region?: string };
}

type StoreS3Audit = Pick<Awaited<ReturnType<typeof loadStoreS3>>, "s3AuditSink">;

const trimSlashes = (p: string): string => p.replace(/^\/+|\/+$/g, "");

function parseConfig(raw: string): AuditConfig {
  const usage = `YNM_AUDIT must be JSON like {"sink":"stdout"}, with sink one of ${SINKS.join(", ")}`;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${usage}; it is not valid JSON`);
  }
  const parsed = AuditConfig.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new Error(`${usage} (${detail})`);
  }
  return parsed.data;
}

/**
 * The audit sink `YNM_AUDIT` asks for, or undefined when audit is off. Unset, audit goes to stdout
 * when the server checks tokens and is off otherwise. The s3 sink loads @ynm/store-s3 lazily, so
 * the AWS SDK stays out of builds that never use it; `loadS3` is injectable for tests.
 */
export async function auditSinkFromEnv(
  env: NodeJS.ProcessEnv,
  defaults: AuditDefaults,
  loadS3: () => Promise<StoreS3Audit> = () => loadStoreS3("audit")
): Promise<AuditSink | undefined> {
  const raw = env.YNM_AUDIT?.trim();
  if (!raw) return defaults.authenticated ? stdoutSink() : undefined;
  const cfg = parseConfig(raw);
  switch (cfg.sink) {
    case "off":
      return undefined;
    case "stdout":
      return stdoutSink();
    case "file":
      if (!cfg.path) throw new Error('YNM_AUDIT: the file sink needs a "path"');
      return fileSink(cfg.path);
    case "s3": {
      const store = defaults.s3Store;
      const bucket = cfg.bucket ?? store?.bucket;
      if (!bucket)
        throw new Error('YNM_AUDIT: the s3 sink needs a "bucket" when the store is not on S3');
      const storePrefix = store && store.bucket === bucket ? trimSlashes(store.prefix) : "";
      const prefix =
        cfg.prefix !== undefined
          ? trimSlashes(cfg.prefix)
          : store?.prefix && trimSlashes(store.prefix)
            ? `audit/${trimSlashes(store.prefix)}`
            : "audit";
      // A lifecycle rule meant for audit events must never be able to expire memory.
      if (storePrefix && (prefix === storePrefix || prefix.startsWith(`${storePrefix}/`)))
        throw new Error(
          `YNM_AUDIT: the s3 audit prefix "${prefix}" sits under the store's prefix "${storePrefix}"; choose one outside it`
        );
      if (!prefix && store?.bucket === bucket)
        throw new Error(
          "YNM_AUDIT: the s3 audit prefix must not be empty when audit shares the store's bucket"
        );
      let mod: StoreS3Audit;
      try {
        mod = await loadS3();
      } catch (err) {
        throw new Error(
          `YNM_AUDIT: the s3 audit sink is not available in this build of ynm: ${(err as Error).message}`
        );
      }
      const sink = mod.s3AuditSink({
        bucket,
        prefix,
        region: cfg.region ?? store?.region,
      });
      return { write: (event) => sink.write(event) };
    }
  }
}
