/**
 * Telemetry for tests: in-memory exporters behind the real SDK set-up, and everything they
 * received as plain data, so a test can assert on spans, events, logs and metrics, or search all
 * of it for a string that must never be exported.
 */
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
