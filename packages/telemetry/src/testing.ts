/**
 * Telemetry for tests: in-memory exporters behind the real SDK set-up, and everything they
 * received as plain data, so a test can assert on spans, events, logs and metrics, or search all
 * of it for a string that must never be exported.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import {
  flushTelemetry,
  type StartOptions,
  shutdownTelemetry,
  startTelemetry,
} from "./telemetry.js";

export interface ExportedSpan {
  name: string;
  kind: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  status: { code: number; message?: string };
  attributes: Record<string, unknown>;
  events: Array<{ name: string; attributes?: Record<string, unknown> }>;
  resource: Record<string, unknown>;
}

export interface ExportedLog {
  eventName?: string;
  severityText?: string;
  body?: unknown;
  attributes: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
}

export interface Exported {
  spans: ExportedSpan[];
  logs: ExportedLog[];
  metrics: ResourceMetrics[];
  /** Everything above as one JSON string, for searching. */
  text: string;
}

export interface MemoryTelemetry {
  /** Flushes and returns everything exported so far. */
  exported(): Promise<Exported>;
  /** Forgets what was exported so far. */
  reset(): void;
  /** Stops telemetry; the facade is a no-op again. */
  stop(): Promise<void>;
}

/** Starts telemetry with in-memory exporters, whatever the environment says. */
export async function startMemoryTelemetry(
  opts: Omit<StartOptions, "exporters"> = { version: "0.0.0-test" }
): Promise<MemoryTelemetry> {
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const on = await startTelemetry({ ...opts, exporters: { spans, logs, metrics } });
  if (!on) throw new Error("telemetry did not start");
  return {
    async exported() {
      await flushTelemetry(5000);
      const s: ExportedSpan[] = spans.getFinishedSpans().map((x) => ({
        name: x.name,
        kind: x.kind,
        traceId: x.spanContext().traceId,
        spanId: x.spanContext().spanId,
        parentSpanId: x.parentSpanContext?.spanId,
        status: x.status,
        attributes: { ...x.attributes },
        events: x.events.map((e) => ({ name: e.name, attributes: e.attributes })),
        resource: { ...x.resource.attributes },
      }));
      const l: ExportedLog[] = logs.getFinishedLogRecords().map((x) => ({
        eventName: x.eventName,
        severityText: x.severityText,
        body: x.body,
        attributes: { ...x.attributes },
        traceId: x.spanContext?.traceId,
        spanId: x.spanContext?.spanId,
      }));
      const m = metrics.getMetrics();
      return { spans: s, logs: l, metrics: m, text: JSON.stringify({ s, l, m }) };
    },
    reset() {
      spans.reset();
      logs.reset();
      metrics.reset();
    },
    stop: () => shutdownTelemetry(5000),
  };
}

/** A span as the spool holds it (OTLP JSON: hex ids, the OTLP span kind numbering). */
export interface SpooledSpan {
  name: string;
  /** OTLP's numbering: 1 internal, 2 server, 3 client. */
  kind: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Record<string, unknown>;
}

export interface Spooled {
  /** The writer folder's file names, sorted. */
  files: string[];
  spans: SpooledSpan[];
  /** Event names of the log records that are events. */
  events: string[];
  /** Names of the metrics written. */
  metrics: string[];
  /** Every line of every file, for searching. */
  text: string;
}

type OtlpAttribute = { key: string; value: Record<string, unknown> };
const attributesOf = (list: OtlpAttribute[] = []) =>
  Object.fromEntries(list.map((a) => [a.key, Object.values(a.value)[0]]));

/** Reads a spool writer folder: every complete OTLP JSON line in its `.jsonl` files. */
export function readSpool(dir: string): Spooled {
  const files = existsSync(dir) ? readdirSync(dir).sort() : [];
  const lines = files
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
    .filter((l) => l.trim() !== "");
  const out: Spooled = { files, spans: [], events: [], metrics: [], text: lines.join("\n") };
  for (const line of lines) {
    const req = JSON.parse(line);
    for (const rs of req.resourceSpans ?? [])
      for (const ss of rs.scopeSpans ?? [])
        for (const s of ss.spans ?? [])
          out.spans.push({
            name: s.name,
            kind: s.kind,
            traceId: s.traceId,
            spanId: s.spanId,
            parentSpanId: s.parentSpanId || undefined,
            attributes: attributesOf(s.attributes),
          });
    for (const rl of req.resourceLogs ?? [])
      for (const sl of rl.scopeLogs ?? [])
        for (const l of sl.logRecords ?? []) if (l.eventName) out.events.push(l.eventName);
    for (const rm of req.resourceMetrics ?? [])
      for (const sm of rm.scopeMetrics ?? [])
        for (const m of sm.metrics ?? []) out.metrics.push(m.name);
  }
  return out;
}
