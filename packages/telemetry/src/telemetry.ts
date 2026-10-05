/**
 * OpenTelemetry for ynm (ADR-018), behind a facade that costs nothing when telemetry is off.
 * Nothing in this module imports an @opentelemetry package: `startTelemetry` loads the SDK, and
 * the ynr spool exporter with it, through a dynamic import, and only when the environment names an
 * OTLP endpoint or a spool. Until then, and in every process where it never does, each call below
 * runs the caller's function unchanged.
 *
 * Telemetry describes ynm's work, never its memory: callers pass ids, counts, tool names and
 * outcomes, never record content, query text or tool arguments, and every string value is put
 * through the redaction patterns before it is exported. It never blocks and never fails: the SDK
 * batches, flushes are bounded in time, and export errors are counted and swallowed.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { format } from "node:util";
import { compilePatterns, logBody, redactText } from "./redact.js";
import type { Runtime } from "./sdk.js";

/** How a unit of work ended; span status is set from it. */
export type Outcome = "ok" | "error" | "refused";
export type AttributeValue = string | number | boolean | readonly string[];
/** Attributes as callers pass them; undefined values are dropped. */
export type Attributes = Record<string, AttributeValue | undefined>;
/** Attributes as exported. */
export type ExportedAttributes = Record<string, string | number | boolean | string[]>;
export type LogLevel = "info" | "warn" | "error";

/** What a function running inside a span can say about it. */
export interface SpanHandle {
  /** Adds attributes to the span, such as counts known only at the end. */
  set(attributes: Attributes): void;
  /** Sets the outcome (`ok` unless the function throws, which makes it `error`). */
  outcome(outcome: Outcome, errorType?: string): void;
}

/** A span ended by its caller, for work that is not one async function (a streamed scan). */
export interface OpenSpan {
  set(attributes: Attributes): void;
  /** Ends the span; only the first call counts. */
  end(outcome: Outcome, errorType?: string): void;
}

export interface SpanOptions {
  /** `server` for a request or tool call, `client` for a call out to a store. Default internal. */
  kind?: "server" | "client" | "internal";
  attributes?: Attributes;
  /** The event emitted as the span begins, so a crash shows as a start with no finish. */
  started?: string;
  /** W3C trace context of an incoming request; the span joins that trace when it is valid. */
  carrier?: { traceparent?: string | null; tracestate?: string | null };
  /**
   * The histogram the span's duration is recorded on. Its attributes are the ones the registry
   * declares for that metric, taken from the span's, so nothing high-cardinality reaches it.
   */
  metric?: string;
}

/** Where telemetry is written for one signal. */
export type Protocol = "http/protobuf" | "http/json";
export type Signal = "traces" | "logs" | "metrics";

/** Where this process writes telemetry, chosen once at start. */
export type Target =
  | { kind: "otlp"; signals: Partial<Record<Signal, Protocol>> }
  /** OTLP JSON lines in a ynr spool writer folder; `dir` is that folder. */
  | { kind: "spool"; dir: string; signals: Signal[] }
  | { kind: "off"; reason?: string };

const SIGNALS: ReadonlyArray<[Signal, string]> = [
  ["traces", "TRACES"],
  ["logs", "LOGS"],
  ["metrics", "METRICS"],
];

const set = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";

/**
 * The ynr spool's laptop writer folder, `$XDG_STATE_HOME/ynr/spool/local`, with XDG_STATE_HOME
 * defaulting to `~/.local/state` (a relative XDG_STATE_HOME is ignored, as the XDG spec says).
 */
export function defaultSpoolDir(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME?.trim();
  const base =
    state && isAbsolute(state) ? state : join(env.HOME?.trim() || homedir(), ".local", "state");
  return join(base, "ynr", "spool", "local");
}

/** One stat: whether `dir` is a folder. Never throws. */
function isFolder(dir: string): boolean {
  try {
    return statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

/**
 * Where to write, in the order the ynr contract gives: the operator's `OTEL_EXPORTER_OTLP_*`
 * endpoint, then the ynr spool, then nothing. A signal is exported when the generic endpoint or
 * its own is set and its `OTEL_<SIGNAL>_EXPORTER` is not `none`; `OTEL_SDK_DISABLED=true` turns
 * everything off. With no endpoint, `YNR_SPOOL` names the writer folder to write to (created on
 * the first write), or the laptop default is used when it exists. Synchronous, and at most one
 * stat.
 */
export function telemetryTarget(env: NodeJS.ProcessEnv = process.env): Target {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true")
    return { kind: "off", reason: "OTEL_SDK_DISABLED is true" };
  const signals: Partial<Record<Signal, Protocol>> = {};
  const unsupported: string[] = [];
  for (const [signal, key] of SIGNALS) {
    if (env[`OTEL_${key}_EXPORTER`]?.trim().toLowerCase() === "none") continue;
    if (!set(env.OTEL_EXPORTER_OTLP_ENDPOINT) && !set(env[`OTEL_EXPORTER_OTLP_${key}_ENDPOINT`]))
      continue;
    const protocol = (
      env[`OTEL_EXPORTER_OTLP_${key}_PROTOCOL`] ??
      env.OTEL_EXPORTER_OTLP_PROTOCOL ??
      "http/protobuf"
    ).trim();
    if (protocol === "http/protobuf" || protocol === "http/json") signals[signal] = protocol;
    else unsupported.push(`${signal} over ${protocol}`);
  }
  if (Object.keys(signals).length) return { kind: "otlp", signals };
  if (unsupported.length)
    return {
      kind: "off",
      reason: `OTLP ${unsupported.join(", ")} is not supported; use http/protobuf or http/json`,
    };
  const spooled = SIGNALS.filter(
    ([, key]) => env[`OTEL_${key}_EXPORTER`]?.trim().toLowerCase() !== "none"
  ).map(([signal]) => signal);
  if (!spooled.length) return { kind: "off" };
  if (set(env.YNR_SPOOL))
    return { kind: "spool", dir: resolve(env.YNR_SPOOL.trim()), signals: spooled };
  const laptop = defaultSpoolDir(env);
  if (isFolder(laptop)) return { kind: "spool", dir: laptop, signals: spooled };
  return { kind: "off" };
}

export interface StartOptions {
  /** ynm's version, for `service.version`. */
  version: string;
  env?: NodeJS.ProcessEnv;
  /** Redaction patterns, beside any added later with `addRedaction`. */
  redaction?: readonly string[];
  /** Forward the server's `[ynm-mcp …]` stderr lines as log records, leaving them unchanged. */
  bridgeConsole?: boolean;
  /**
   * A long-lived server: when there is nothing to write to, look again once a minute, and start
   * when a spool appears. The timer is unref'd and does nothing else.
   */
  recheck?: boolean;
  /**
   * The longest one export may take, retries included. A short-lived process sets it to its exit
   * bound, so a collector that is down cannot hold the process open after its work is done.
   */
  exportTimeoutMs?: number;
  /**
   * SDK exporters to use instead of OTLP (tests). Telemetry is then on whatever the environment
   * says. Typed loosely so this module needs no OpenTelemetry types.
   */
  exporters?: { spans?: unknown; logs?: unknown; metrics?: unknown };
}

let runtime: Runtime | undefined;
let starting: Promise<boolean> | undefined;
let rechecking: ReturnType<typeof setInterval> | undefined;
/** How often a long-lived server with telemetry off looks for a spool again. */
export const RECHECK_MS = 60_000;
let namespaces = false;
const patternSources: string[] = [];
let patterns: RegExp[] = [];

/** Adds redaction patterns (a store's configured ones); string values are redacted with them. */
export function addRedaction(more: readonly string[]): void {
  const fresh = more.filter((p) => !patternSources.includes(p));
  if (!fresh.length) return;
  patternSources.push(...fresh);
  patterns = compilePatterns(patternSources);
}

/** A string as it would be exported: redacted and capped. */
export function redact(text: string): string {
  return redactText(text, patterns);
}

/** Whether telemetry is running in this process. */
export function telemetryEnabled(): boolean {
  return runtime !== undefined;
}

/** Whether a store call's namespace may be exported (YNM_TELEMETRY_NAMESPACES=1). */
export function namespacesIncluded(): boolean {
  return namespaces;
}

/**
 * Starts telemetry once per process, when the environment asks for it, and says whether it is
 * on. With nothing to write to, nothing is imported. A failure to start is reported once on
 * stderr and leaves telemetry off; it never reaches the caller.
 */
export function startTelemetry(opts: StartOptions): Promise<boolean> {
  if (starting) return starting;
  const env = opts.env ?? process.env;
  addRedaction(opts.redaction ?? []);
  const target: Target = opts.exporters ? { kind: "otlp", signals: {} } : telemetryTarget(env);
  if (target.kind === "off") {
    if (target.reason) warn(target.reason);
    else if (opts.recheck) recheckLater(opts);
    return Promise.resolve(false);
  }
  stopRechecking();
  namespaces = env.YNM_TELEMETRY_NAMESPACES === "1";
  starting = import("./sdk.js")
    .then((sdk) =>
      sdk.createRuntime({
        version: opts.version,
        env,
        target,
        exporters: opts.exporters,
        exportTimeoutMs: opts.exportTimeoutMs,
        clean,
      })
    )
    .then((r) => {
      runtime = r;
      if (opts.bridgeConsole) bridgeConsole();
      return true;
    })
    .catch((err: unknown) => {
      warn(err instanceof Error ? err.message : String(err));
      starting = undefined;
      return false;
    });
  return starting;
}

/**
 * Looks for a spool again once a minute, and starts telemetry when there is one. Work already
 * in flight when it starts has no spans.
 */
function recheckLater(opts: StartOptions): void {
  if (rechecking) return;
  rechecking = setInterval(() => {
    try {
      if (telemetryTarget(opts.env ?? process.env).kind === "off") return;
    } catch {
      return;
    }
    stopRechecking();
    void startTelemetry({ ...opts, recheck: false });
  }, RECHECK_MS);
  rechecking.unref?.();
}

function stopRechecking(): void {
  if (rechecking) clearInterval(rechecking);
  rechecking = undefined;
}

function warn(why: string): void {
  try {
    process.stderr.write(`ynm: telemetry is off: ${why}\n`);
  } catch {}
}

/** Attributes as exported: undefined dropped, strings redacted and capped, namespaces opt-in. */
function clean(attributes: Attributes | undefined): ExportedAttributes {
  const out: ExportedAttributes = {};
  for (const [k, v] of Object.entries(attributes ?? {})) {
    if (v === undefined || (k === "ynm.namespace" && !namespaces)) continue;
    if (typeof v === "string") out[k] = redact(v);
    else if (Array.isArray(v)) out[k] = v.slice(0, 64).map((s) => redact(String(s)));
    else out[k] = v as number | boolean;
  }
  return out;
}

const NOOP: SpanHandle = { set: () => {}, outcome: () => {} };

/**
 * Runs `fn` as one unit of work: a span (a child of the active one, of an incoming request's
 * trace, or of the process's TRACEPARENT), its `started` event, and its duration on the metric.
 * When telemetry is off this is `fn(noop)`. What `fn` returns or throws is passed through as is.
 */
export function withSpan<T>(
  name: string,
  opts: SpanOptions,
  fn: (span: SpanHandle) => Promise<T>
): Promise<T> {
  return runtime ? runtime.span(name, opts, fn) : fn(NOOP);
}

const CLOSED: OpenSpan = { set: () => {}, end: () => {} };

/**
 * Starts a span the caller ends, as a child of the active span. It does not become the active
 * span itself, so it suits work that yields between steps, such as an async iterator.
 */
export function beginSpan(name: string, opts: SpanOptions): OpenSpan {
  try {
    return runtime ? runtime.begin(name, opts) : CLOSED;
  } catch {
    return CLOSED;
  }
}

/** Emits an event (a log record with an event name), in the active span's context. */
export function emitEvent(name: string, attributes: Attributes): void {
  try {
    runtime?.event(name, attributes);
  } catch {}
}

/** Emits a log record; the body is redacted and its quoted strings masked. */
export function emitLog(level: LogLevel, line: string): void {
  try {
    runtime?.log(level, logBody(line, patterns));
  } catch {}
}

/** W3C trace context, as passed to a call out: `traceparent`, and `tracestate` when there is one. */
export interface TraceContext {
  traceparent: string;
  tracestate?: string;
}

/**
 * The active span's trace context, to pass on to a process or a request ynm makes (the ynr
 * contract's "pass the trace on"). Undefined when telemetry is off or no span is active, so a call
 * out then carries whatever it would have carried without telemetry.
 */
export function traceContext(): TraceContext | undefined {
  try {
    return runtime?.traceContext();
  } catch {
    return undefined;
  }
}

/**
 * The environment for a process ynm spawns: `env` with `TRACEPARENT` (and `TRACESTATE`, or none)
 * set to the active span, so the child nests under it, replacing any ynm inherited. With
 * telemetry off or no active span, `env` itself is returned, so the child inherits exactly what it
 * did before. Costs one branch when off.
 */
export function traceEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const tc = traceContext();
  if (!tc) return env;
  const out: NodeJS.ProcessEnv = { ...env, TRACEPARENT: tc.traceparent };
  if (tc.tracestate) out.TRACESTATE = tc.tracestate;
  else delete out.TRACESTATE;
  return out;
}

/**
 * A fetch that adds the active span's `traceparent` and `tracestate` headers to each request it
 * sends to `origin`, decided per call, so telemetry starting later is picked up. Trace context
 * goes only to our own tools, such as a hosted ynm, never to a third party, so a request to any
 * other origin (an identity provider the transport refreshes a token with, say) is sent as is.
 * With telemetry off or no active span it calls `f` (default, the global fetch) with exactly the
 * arguments it was given.
 */
export function tracedFetch(origin: string, f?: typeof fetch): typeof fetch {
  return (input, init) => {
    const send = f ?? fetch;
    const tc = traceContext();
    if (!tc || originOf(input) !== origin) return send(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    headers.set("traceparent", tc.traceparent);
    if (tc.tracestate) headers.set("tracestate", tc.tracestate);
    else headers.delete("tracestate");
    return send(input, { ...init, headers });
  };
}

function originOf(input: string | URL | Request): string | undefined {
  try {
    return new URL(input instanceof Request ? input.url : input).origin;
  } catch {
    return undefined;
  }
}

/** Resolves when `p` settles or `ms` passes, whichever is first; never rejects. */
function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
    p.then(
      () => resolve(),
      () => resolve()
    ).finally(() => clearTimeout(timer));
  });
}

/**
 * Exports what is buffered, and flushes the spool's open file to disk, giving up after `ms`
 * (default 2 seconds). Called at the end of a unit of work, such as a Lambda invocation.
 */
export async function flushTelemetry(ms = 2000): Promise<void> {
  if (runtime && ms > 0) await bounded(runtime.flush(), ms);
}

/**
 * Flushes and stops telemetry, giving up after `ms`, so a process can exit with its exit code
 * unchanged. Afterwards everything is a no-op again until the next `startTelemetry`.
 */
export async function shutdownTelemetry(ms = 2000): Promise<void> {
  stopRechecking();
  if (starting) await bounded(starting, ms);
  const r = runtime;
  runtime = undefined;
  starting = undefined;
  unbridgeConsole();
  if (r) await bounded(r.shutdown(), ms);
}

// ---------------------------------------------------------------------------------------------
// The logger bridge: the server logs to stderr with console.error and console.info. Those lines
// are forwarded as log records when telemetry is on, and printed exactly as before.

const SERVER_LINE = /^\[?ynm-mcp[\] ]/;
type ConsoleMethod = "error" | "warn" | "info";
let original: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> | undefined;

function bridgeConsole(): void {
  if (original) return;
  original = {};
  const levels: Record<ConsoleMethod, LogLevel> = { error: "error", warn: "warn", info: "info" };
  for (const method of Object.keys(levels) as ConsoleMethod[]) {
    const print = console[method];
    original[method] = print;
    console[method] = (...args: unknown[]) => {
      print.apply(console, args);
      if (typeof args[0] === "string" && SERVER_LINE.test(args[0]))
        emitLog(levels[method], format(...args));
    };
  }
}

function unbridgeConsole(): void {
  if (!original) return;
  for (const [method, print] of Object.entries(original))
    if (print) console[method as ConsoleMethod] = print;
  original = undefined;
}
