/**
 * OpenTelemetry for ynm (ADR-018), behind a facade that costs nothing when telemetry is off.
 * Nothing in this module imports an @opentelemetry package: `startTelemetry` loads the SDK through
 * a dynamic import, and only when the environment names an OTLP endpoint. Until then, and in every
 * process where it never does, each call below runs the caller's function unchanged.
 *
 * Telemetry describes ynm's work, never its memory: callers pass ids, counts, tool names and
 * outcomes, never record content, query text or tool arguments, and every string value is put
 * through the redaction patterns before it is exported. It never blocks and never fails: the SDK
 * batches, flushes are bounded in time, and export errors are counted and swallowed.
 */
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
  | { kind: "off"; reason?: string };

const SIGNALS: ReadonlyArray<[Signal, string]> = [
  ["traces", "TRACES"],
  ["logs", "LOGS"],
  ["metrics", "METRICS"],
];

const set = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";

/**
 * Where to write, in the order the ynr contract gives: the operator's `OTEL_EXPORTER_OTLP_*`
 * endpoint, then the ynr spool, then nothing. A signal is exported when the generic endpoint or
 * its own is set and its `OTEL_<SIGNAL>_EXPORTER` is not `none`; `OTEL_SDK_DISABLED=true` turns
 * everything off.
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
  // The ynr spool goes here, between the operator's endpoint and nothing: YNR_SPOOL naming a
  // folder, or $XDG_STATE_HOME/ynr/spool/local existing, once its exporter package is published.
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
    return Promise.resolve(false);
  }
  namespaces = env.YNM_TELEMETRY_NAMESPACES === "1";
  starting = import("./sdk.js")
    .then((sdk) =>
      sdk.createRuntime({
        version: opts.version,
        env,
        signals: target.signals,
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

/** Exports what is buffered, giving up after `ms` (default 2 seconds). */
export async function flushTelemetry(ms = 2000): Promise<void> {
  if (runtime && ms > 0) await bounded(runtime.flush(), ms);
}

/**
 * Flushes and stops telemetry, giving up after `ms`, so a process can exit with its exit code
 * unchanged. Afterwards everything is a no-op again until the next `startTelemetry`.
 */
export async function shutdownTelemetry(ms = 2000): Promise<void> {
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
