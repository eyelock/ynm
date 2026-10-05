/**
 * The OpenTelemetry SDK, set up for ynm, and the ynr spool exporter. Only ever loaded by
 * `startTelemetry` through a dynamic import, so a process with telemetry off never loads any of
 * this (ADR-018).
 */
import { randomUUID } from "node:crypto";
import {
  SpoolLogExporter,
  SpoolMetricExporter,
  SpoolSpanExporter,
  SpoolWriter,
} from "@eyelock/otel-spool-exporter";
import {
  type Context,
  context,
  defaultTextMapGetter,
  type Histogram,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  type ExportResult,
  ExportResultCode,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { OTLPLogExporter as JsonLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as ProtoLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter as JsonMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as ProtoMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as JsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, type SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";
import {
  ATTR_ERROR_TYPE,
  ATTR_YNM_OUTCOME,
  ATTR_YNM_TELEMETRY_SIGNAL,
  METRIC_CARDINALITY_LIMITS,
  METRIC_YNM_TELEMETRY_EXPORT_FAILURES,
  METRIC_YNM_TELEMETRY_SPOOL_DROPPED,
  METRIC_YNM_TELEMETRY_SPOOL_ERRORS,
  REGISTRY,
} from "./registry.gen.js";
import type {
  Attributes,
  ExportedAttributes,
  LogLevel,
  OpenSpan,
  Outcome,
  Signal,
  SpanHandle,
  SpanOptions,
  Target,
} from "./telemetry.js";

/** What the facade calls once the SDK is running. */
export interface Runtime {
  span<T>(name: string, opts: SpanOptions, fn: (span: SpanHandle) => Promise<T>): Promise<T>;
  begin(name: string, opts: SpanOptions): OpenSpan;
  event(name: string, attributes: Attributes): void;
  log(level: LogLevel, body: string): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface RuntimeOptions {
  version: string;
  env: NodeJS.ProcessEnv;
  /** Where to write; ignored when `exporters` is given. */
  target: Exclude<Target, { kind: "off" }>;
  exporters?: { spans?: unknown; logs?: unknown; metrics?: unknown };
  exportTimeoutMs?: number;
  /** The facade's attribute cleaner: drops undefined, redacts strings, leaves namespaces out. */
  clean: (attributes: Attributes | undefined) => ExportedAttributes;
}

/** Spans and logs are written in batches at least once a second. */
const BATCH_DELAY_MS = 1000;

const KIND = { server: SpanKind.SERVER, client: SpanKind.CLIENT, internal: SpanKind.INTERNAL };
const SEVERITY: Record<LogLevel, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

/** The attribute keys the registry declares for each metric. */
const METRIC_KEYS: ReadonlyMap<string, readonly string[]> = new Map(
  REGISTRY.groups
    .filter((g) => g.type === "metric")
    .map((g) => [
      (g as { metric_name: string }).metric_name,
      (g.attributes as ReadonlyArray<{ ref?: string }>).map((a) => a.ref as string),
    ])
);

type Exporter = { export(items: unknown, done: (r: ExportResult) => void): void };

/**
 * An exporter whose failures are counted, never thrown or reported: telemetry must not fail or
 * slow ynm because a collector is down.
 */
function guarded<E extends object>(inner: E, signal: Signal, failures: Record<Signal, number>): E {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "export")
        return (items: unknown, done: (r: ExportResult) => void) => {
          try {
            (target as unknown as Exporter).export(items, (r) => {
              if (r.code !== ExportResultCode.SUCCESS) failures[signal] += 1;
              done(r);
            });
          } catch {
            failures[signal] += 1;
            done({ code: ExportResultCode.FAILED });
          }
        };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/**
 * The OTLP exporters, configured from the standard variables in the process environment (the
 * exporters read it themselves). `timeoutMs` caps how long one
 * export, retries included, may keep a short-lived process alive after its work is done.
 */
function otlpExporters(
  signals: Extract<Target, { kind: "otlp" }>["signals"],
  env: NodeJS.ProcessEnv,
  cap?: number
) {
  const json = (s: Signal) => signals[s] === "http/json";
  const fromEnv = Number(env.OTEL_EXPORTER_OTLP_TIMEOUT);
  const configured = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 10_000;
  const c = cap ? { timeoutMillis: Math.min(configured, cap) } : {};
  return {
    spans: signals.traces
      ? json("traces")
        ? new JsonTraceExporter(c)
        : new ProtoTraceExporter(c)
      : undefined,
    logs: signals.logs
      ? json("logs")
        ? new JsonLogExporter(c)
        : new ProtoLogExporter(c)
      : undefined,
    metrics: signals.metrics
      ? json("metrics")
        ? new JsonMetricExporter(c)
        : new ProtoMetricExporter(c)
      : undefined,
  };
}

function metricInterval(env: NodeJS.ProcessEnv): number {
  const n = Number(env.OTEL_METRIC_EXPORT_INTERVAL);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/**
 * The spool exporters, sharing one writer that names its files after the service and instance:
 * `<service>-<instance id>-<seq>.jsonl` in the writer folder.
 */
function spoolExporters(
  target: Extract<Target, { kind: "spool" }>,
  resource: { attributes: Record<string, unknown> },
  cap?: number
) {
  const writer = new SpoolWriter({
    dir: target.dir,
    service: String(resource.attributes["service.name"] ?? "ynm"),
    instanceId: String(resource.attributes["service.instance.id"] ?? randomUUID()),
    ...(cap ? { syncTimeoutMs: cap } : {}),
  });
  const on = (s: Signal) => target.signals.includes(s);
  return {
    writer,
    spans: on("traces") ? new SpoolSpanExporter(writer) : undefined,
    logs: on("logs") ? new SpoolLogExporter(writer) : undefined,
    metrics: on("metrics") ? new SpoolMetricExporter(writer) : undefined,
  };
}

export async function createRuntime(opts: RuntimeOptions): Promise<Runtime> {
  const { clean, env, target } = opts;
  // OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME win over ynm's own values.
  const resource = resourceFromAttributes({
    "service.name": "ynm",
    "service.version": opts.version,
    "service.instance.id": randomUUID(),
  }).merge(detectResources({ detectors: [envDetector] }));
  const spool =
    !opts.exporters && target.kind === "spool"
      ? spoolExporters(target, resource, opts.exportTimeoutMs)
      : undefined;
  const writer = spool?.writer;
  const exporters = (opts.exporters ??
    spool ??
    otlpExporters(target.kind === "otlp" ? target.signals : {}, env, opts.exportTimeoutMs)) as {
    spans?: SpanExporter;
    logs?: LogRecordExporter;
    metrics?: PushMetricExporter;
  };
  const failures: Record<Signal, number> = { traces: 0, logs: 0, metrics: 0 };

  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: exporters.spans
      ? [
          new BatchSpanProcessor({
            exporter: guarded(exporters.spans, "traces", failures),
            scheduledDelayMillis: BATCH_DELAY_MS,
          }),
        ]
      : [],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: exporters.logs
      ? [
          new BatchLogRecordProcessor({
            exporter: guarded(exporters.logs, "logs", failures),
            scheduledDelayMillis: BATCH_DELAY_MS,
          }),
        ]
      : [],
  });
  const meterProvider = new MeterProvider({
    resource,
    views: Object.entries(METRIC_CARDINALITY_LIMITS).map(([instrumentName, limit]) => ({
      instrumentName,
      aggregationCardinalityLimit: limit,
    })),
    readers: exporters.metrics
      ? [
          new PeriodicExportingMetricReader({
            exporter: guarded(exporters.metrics, "metrics", failures),
            exportIntervalMillis: metricInterval(env),
          }),
        ]
      : [],
  });

  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  const propagator = new W3CTraceContextPropagator();
  const tracer = tracerProvider.getTracer("ynm", opts.version);
  const logger = loggerProvider.getLogger("ynm", opts.version);
  const meter = meterProvider.getMeter("ynm", opts.version);
  meter
    .createObservableCounter(METRIC_YNM_TELEMETRY_EXPORT_FAILURES, { unit: "{export}" })
    .addCallback((result) => {
      for (const [signal, n] of Object.entries(failures))
        result.observe(n, { [ATTR_YNM_TELEMETRY_SIGNAL]: signal });
    });
  // The spool writer never reports a failure to the SDK; what it could not do is counted here.
  if (writer) {
    meter
      .createObservableCounter(METRIC_YNM_TELEMETRY_SPOOL_DROPPED, { unit: "{record}" })
      .addCallback((result) => result.observe(writer.stats().dropped));
    meter
      .createObservableCounter(METRIC_YNM_TELEMETRY_SPOOL_ERRORS, { unit: "{operation}" })
      .addCallback((result) => result.observe(writer.stats().errors));
  }
  const histograms = new Map<string, Histogram>();

  const extract = (carrier: Record<string, string | null | undefined>): Context | undefined => {
    const c: Record<string, string> = {};
    for (const [k, v] of Object.entries(carrier)) if (v) c[k] = v;
    if (!c.traceparent) return undefined;
    const ctx = propagator.extract(ROOT_CONTEXT, c, defaultTextMapGetter);
    return trace.getSpanContext(ctx) ? ctx : undefined;
  };
  // A process joins the trace it was started in (TRACEPARENT and TRACESTATE).
  const processContext =
    extract({ traceparent: env.TRACEPARENT, tracestate: env.TRACESTATE }) ?? ROOT_CONTEXT;
  const parentFor = (carrier: SpanOptions["carrier"]): Context => {
    const fromCarrier = carrier && extract(carrier);
    if (fromCarrier) return fromCarrier;
    const active = context.active();
    return trace.getSpan(active) ? active : processContext;
  };

  const emit = (name: string, attributes: Attributes, ctx: Context) =>
    logger.emit({
      eventName: name,
      severityNumber: SeverityNumber.INFO,
      attributes: clean(attributes),
      context: ctx,
    });

  const record = (metric: string, seconds: number, attributes: Record<string, unknown>) => {
    const keys = METRIC_KEYS.get(metric);
    if (!keys) return;
    let h = histograms.get(metric);
    if (!h) {
      h = meter.createHistogram(metric, { unit: "s" });
      histograms.set(metric, h);
    }
    const picked: Attributes = {};
    for (const k of keys) picked[k] = attributes[k] as Attributes[string];
    h.record(seconds, clean(picked));
  };

  /** Ends a span with its outcome; never throws. */
  const finish = (
    span: Span,
    opts: SpanOptions,
    attrs: Attributes,
    startedAt: number,
    outcome: Outcome,
    errorType: string | undefined
  ) => {
    try {
      span.setAttribute(ATTR_YNM_OUTCOME, outcome);
      if (errorType) span.setAttribute(ATTR_ERROR_TYPE, redactType(errorType));
      if (outcome === "ok") span.setStatus({ code: SpanStatusCode.OK });
      else if (outcome === "error") span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      if (opts.metric)
        record(opts.metric, (performance.now() - startedAt) / 1000, {
          ...attrs,
          [ATTR_YNM_OUTCOME]: outcome,
        });
    } catch {}
  };

  /** Starts a span under the right parent and emits its `started` event. */
  const start = (name: string, opts: SpanOptions, attrs: Attributes) => {
    const parent = parentFor(opts.carrier);
    const span = tracer.startSpan(
      name,
      { kind: KIND[opts.kind ?? "internal"], attributes: clean(attrs) },
      parent
    );
    const ctx = trace.setSpan(parent, span);
    if (opts.started) emit(opts.started, attrs, ctx);
    return { span, ctx, startedAt: performance.now() };
  };
  const setter = (span: Span, attrs: Attributes) => (more: Attributes) => {
    Object.assign(attrs, more);
    try {
      span.setAttributes(clean(more));
    } catch {}
  };

  return {
    async span(name, opts, fn) {
      const attrs: Attributes = { ...opts.attributes };
      let started: ReturnType<typeof start>;
      try {
        started = start(name, opts, attrs);
      } catch {
        return fn({ set: () => {}, outcome: () => {} });
      }
      const { span, ctx, startedAt } = started;
      let outcome: Outcome | undefined;
      let errorType: string | undefined;
      const handle: SpanHandle = {
        set: setter(span, attrs),
        outcome(o, e) {
          outcome = o;
          errorType = e;
        },
      };
      try {
        const result = await context.with(ctx, () => fn(handle));
        finish(span, opts, attrs, startedAt, outcome ?? "ok", errorType);
        return result;
      } catch (err) {
        finish(span, opts, attrs, startedAt, outcome ?? "error", errorType ?? errorTypeOf(err));
        throw err;
      }
    },
    begin(name, opts) {
      const attrs: Attributes = { ...opts.attributes };
      const { span, startedAt } = start(name, opts, attrs);
      let ended = false;
      return {
        set: setter(span, attrs),
        end(outcome, errorType) {
          if (ended) return;
          ended = true;
          finish(span, opts, attrs, startedAt, outcome, errorType);
        },
      };
    },
    event(name, attributes) {
      emit(name, attributes, context.active());
    },
    log(level, body) {
      logger.emit({
        severityNumber: SEVERITY[level],
        severityText: level.toUpperCase(),
        body,
        context: context.active(),
      });
    },
    // The end of a unit of work: export what is buffered, then put the spool file on disk.
    async flush() {
      await Promise.allSettled([
        tracerProvider.forceFlush(),
        loggerProvider.forceFlush(),
        meterProvider.forceFlush(),
      ]);
      await writer?.sync();
    },
    // The providers flush as they shut down; the writer closes after them, renaming its file.
    async shutdown() {
      await Promise.allSettled([
        tracerProvider.shutdown(),
        loggerProvider.shutdown(),
        meterProvider.shutdown(),
      ]);
      context.disable();
      await writer?.close();
    },
  };
}

/** An error's class name, never its message, which can quote content. */
function errorTypeOf(err: unknown): string {
  return err instanceof Error ? err.name || "Error" : typeof err;
}

/** An error type is a name; anything that does not look like one is reported as `_OTHER`. */
function redactType(t: string): string {
  return /^[\w.:-]{1,64}$/.test(t) ? t : "_OTHER";
}
