import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ExportResultCode } from "@opentelemetry/core";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { afterEach } from "vitest";
import { compilePatterns, logBody, REDACTED, redactText } from "./redact.js";
import {
  ATTR_YNM_OUTCOME,
  EVENT_YNM_TOOL_STARTED,
  METRIC_YNM_TOOL_CALL_DURATION,
} from "./registry.gen.js";
import {
  addRedaction,
  beginSpan,
  emitEvent,
  emitLog,
  flushTelemetry,
  namespacesIncluded,
  redact,
  shutdownTelemetry,
  startTelemetry,
  telemetryEnabled,
  telemetryTarget,
  withSpan,
} from "./telemetry.js";
import { startMemoryTelemetry } from "./testing.js";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT = "00f067aa0ba902b7";
const traceparent = `00-${TRACE}-${PARENT}-01`;

afterEach(() => shutdownTelemetry());

describe("telemetryTarget", () => {
  it("is off with no OTLP endpoint, and names nothing to complain about", () => {
    expect(telemetryTarget({})).toEqual({ kind: "off" });
    expect(telemetryTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " })).toEqual({ kind: "off" });
  });

  it("exports every signal over http/protobuf when the generic endpoint is set", () => {
    expect(telemetryTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" })).toEqual({
      kind: "otlp",
      signals: { traces: "http/protobuf", logs: "http/protobuf", metrics: "http/protobuf" },
    });
  });

  it("exports only the signals with an endpoint, honouring protocols and `none`", () => {
    expect(
      telemetryTarget({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c/v1/traces",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://c/v1/logs",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_LOGS_EXPORTER: "none",
      })
    ).toEqual({ kind: "otlp", signals: { traces: "http/json" } });
  });

  it("is off, with a reason, for OTEL_SDK_DISABLED and for grpc alone", () => {
    expect(
      telemetryTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c", OTEL_SDK_DISABLED: "true" })
    ).toMatchObject({ kind: "off", reason: expect.stringContaining("OTEL_SDK_DISABLED") });
    expect(
      telemetryTarget({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c",
        OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      })
    ).toMatchObject({ kind: "off", reason: expect.stringContaining("grpc") });
  });
});

describe("redaction", () => {
  const patterns = compilePatterns(["AKIA[0-9A-Z]{16}", "(?i)bearer\\s+[a-z0-9._-]{20,}", "("]);

  it("replaces every match, case-insensitively where asked, skipping bad patterns", () => {
    expect(redactText("a AKIAABCDEFGHIJKLMNOP b BEARER abcdefghijklmnopqrstuvwxyz", patterns)).toBe(
      `a ${REDACTED} b ${REDACTED}`
    );
  });

  it("caps strings, and masks quoted strings in log lines", () => {
    expect(redactText("x".repeat(300), patterns)).toHaveLength(257);
    expect(logBody('[ynm-mcp] Unexpected token, "secret body" is not valid JSON', patterns)).toBe(
      '[ynm-mcp] Unexpected token, "…" is not valid JSON'
    );
  });

  it("collects patterns added later", () => {
    addRedaction(["canary-[0-9]+"]);
    expect(redact("a canary-123 b")).toBe(`a ${REDACTED} b`);
  });
});

describe("with telemetry off", () => {
  it("starts nothing and runs work unchanged", async () => {
    expect(await startTelemetry({ version: "1", env: {} })).toBe(false);
    expect(telemetryEnabled()).toBe(false);
    const seen: string[] = [];
    const r = await withSpan("x", { started: "ynm.x.started" }, async (span) => {
      span.set({ a: 1 });
      span.outcome("error");
      seen.push("ran");
      return 42;
    });
    expect(r).toBe(42);
    expect(seen).toEqual(["ran"]);
    await expect(
      withSpan("x", {}, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    emitEvent("ynm.x", {});
    emitLog("info", "x");
    await flushTelemetry();
  });

  it("says why on stderr when the protocol cannot be honoured", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        await startTelemetry({
          version: "1",
          env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" },
        })
      ).toBe(false);
      expect(String(write.mock.calls[0]?.[0])).toContain("telemetry is off");
    } finally {
      write.mockRestore();
    }
  });
});

describe("with telemetry on", () => {
  it("describes the service, and joins the process's TRACEPARENT", async () => {
    const t = await startMemoryTelemetry({ version: "9.9.9", env: { TRACEPARENT: traceparent } });
    expect(telemetryEnabled()).toBe(true);
    await withSpan("ynm recall", { started: "ynm.command.started" }, async () => {});
    const { spans, logs } = await t.exported();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ traceId: TRACE, parentSpanId: PARENT, name: "ynm recall" });
    expect(spans[0]?.resource).toMatchObject({ "service.name": "ynm", "service.version": "9.9.9" });
    expect(spans[0]?.resource["service.instance.id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(logs[0]).toMatchObject({ eventName: "ynm.command.started", traceId: TRACE });
  });

  it("joins an incoming request's trace, and nests work under the active span", async () => {
    const t = await startMemoryTelemetry();
    await withSpan("POST /mcp", { kind: "server", carrier: { traceparent } }, async () => {
      await withSpan("tools/call memory_recall", { kind: "server" }, async () => {
        emitEvent("ynm.inner", { n: 1 });
      });
    });
    const { spans, logs } = await t.exported();
    const outer = spans.find((s) => s.name === "POST /mcp");
    const inner = spans.find((s) => s.name.startsWith("tools/call"));
    expect(outer).toMatchObject({ traceId: TRACE, parentSpanId: PARENT });
    expect(inner).toMatchObject({ traceId: TRACE, parentSpanId: outer?.spanId });
    expect(logs.find((l) => l.eventName === "ynm.inner")?.spanId).toBe(inner?.spanId);
  });

  it("starts a new trace when the carrier is not valid trace context", async () => {
    const t = await startMemoryTelemetry();
    await withSpan("GET /health", { carrier: { traceparent: "nonsense" } }, async () => {});
    const { spans } = await t.exported();
    expect(spans[0]?.traceId).not.toBe(TRACE);
    expect(spans[0]?.parentSpanId).toBeUndefined();
  });

  it("ends with the outcome: ok sets status OK, error sets ERROR and the error's class", async () => {
    const t = await startMemoryTelemetry();
    await withSpan("a", {}, async () => {});
    await withSpan("b", {}, async (s) => s.outcome("refused"));
    class StoreError extends Error {
      override name = "StoreError";
    }
    await expect(
      withSpan("c", {}, async () => {
        throw new StoreError("the canary content");
      })
    ).rejects.toThrow("the canary content");
    const { spans, text } = await t.exported();
    const by = (n: string) => spans.find((s) => s.name === n);
    expect(by("a")).toMatchObject({
      status: { code: 1 },
      attributes: { [ATTR_YNM_OUTCOME]: "ok" },
    });
    expect(by("b")).toMatchObject({
      status: { code: 0 },
      attributes: { [ATTR_YNM_OUTCOME]: "refused" },
    });
    expect(by("c")).toMatchObject({
      status: { code: 2 },
      attributes: { [ATTR_YNM_OUTCOME]: "error", "error.type": "StoreError" },
    });
    expect(text).not.toContain("canary");
  });

  it("records a metric with only the attributes the registry declares for it", async () => {
    const t = await startMemoryTelemetry();
    await withSpan(
      "tools/call memory_recall",
      {
        metric: METRIC_YNM_TOOL_CALL_DURATION,
        started: EVENT_YNM_TOOL_STARTED,
        attributes: { "gen_ai.tool.name": "memory_recall", "ynm.mount": "personal" },
      },
      async (s) => s.set({ "ynm.result.count": 3 })
    );
    const { metrics, spans } = await t.exported();
    expect(spans[0]?.attributes).toMatchObject({ "ynm.result.count": 3, "ynm.mount": "personal" });
    const points = metrics
      .flatMap((r) => r.scopeMetrics)
      .flatMap((s) => s.metrics)
      .filter((m) => m.descriptor.name === METRIC_YNM_TOOL_CALL_DURATION)
      .flatMap((m) => m.dataPoints);
    expect(points.map((p) => p.attributes)).toEqual([
      { "gen_ai.tool.name": "memory_recall", [ATTR_YNM_OUTCOME]: "ok" },
    ]);
  });

  it("redacts strings and leaves namespaces out unless the operator asks", async () => {
    const t = await startMemoryTelemetry({ version: "1", redaction: ["AKIA[0-9A-Z]{16}"] });
    expect(namespacesIncluded()).toBe(false);
    await withSpan(
      "store scan",
      { attributes: { "ynm.namespace": "user/alice", "x.key": "AKIAABCDEFGHIJKLMNOP" } },
      async () => {}
    );
    const { spans } = await t.exported();
    expect(spans[0]?.attributes).toEqual({ "x.key": REDACTED, [ATTR_YNM_OUTCOME]: "ok" });
    await t.stop();
    const t2 = await startMemoryTelemetry({
      version: "1",
      env: { YNM_TELEMETRY_NAMESPACES: "1" },
    });
    await withSpan("store scan", { attributes: { "ynm.namespace": "user/alice" } }, async () => {});
    expect((await t2.exported()).spans[0]?.attributes["ynm.namespace"]).toBe("user/alice");
  });

  it("bridges the server's stderr lines, printing them unchanged", async () => {
    const printed: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...a) => {
      printed.push(a.join(" "));
    });
    try {
      const t = await startMemoryTelemetry({ version: "1", bridgeConsole: true });
      console.error("[ynm-mcp] request POST /mcp 200 3ms");
      console.error("ynm-mcp auth: bearer");
      console.error("something else");
      expect(printed).toEqual([
        "[ynm-mcp] request POST /mcp 200 3ms",
        "ynm-mcp auth: bearer",
        "something else",
      ]);
      const { logs } = await t.exported();
      expect(logs.map((l) => [l.severityText, l.body])).toEqual([
        ["ERROR", "[ynm-mcp] request POST /mcp 200 3ms"],
        ["ERROR", "ynm-mcp auth: bearer"],
      ]);
      await t.stop();
      console.error("[ynm-mcp] after");
      expect(printed.at(-1)).toBe("[ynm-mcp] after");
    } finally {
      error.mockRestore();
    }
  });

  it("swallows and counts exporter failures, and bounds a flush that hangs", async () => {
    const failing = new InMemorySpanExporter();
    failing.export = (_spans, done) => done({ code: ExportResultCode.FAILED });
    const hanging = new InMemoryLogRecordExporter();
    hanging.export = () => {};
    const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    await startTelemetry({ version: "1", exporters: { spans: failing, logs: hanging, metrics } });
    await withSpan("a", { started: "ynm.a.started" }, async () => {});
    const began = Date.now();
    await flushTelemetry(300);
    expect(Date.now() - began).toBeLessThan(2000);
    await flushTelemetry(300);
    const failures = metrics
      .getMetrics()
      .flatMap((r) => r.scopeMetrics)
      .flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === "ynm.telemetry.export.failures");
    const traces = failures?.dataPoints.find(
      (p) => p.attributes["ynm.telemetry.signal"] === "traces"
    );
    expect(traces?.value).toBeGreaterThanOrEqual(1);
    await shutdownTelemetry(300);
    expect(telemetryEnabled()).toBe(false);
  });
});

describe("over OTLP", () => {
  it.each(["http/protobuf", "http/json"])(
    "exports every signal to the endpoint over %s",
    async (protocol) => {
      const seen: Array<{ path?: string; type?: string }> = [];
      const server = createServer((req, res) => {
        seen.push({ path: req.url, type: req.headers["content-type"] });
        req.resume();
        req.on("end", () => res.writeHead(200).end());
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address() as AddressInfo;
      try {
        // The OTLP exporters read their settings from the process environment, as in production.
        const env = {
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
          OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
          OTEL_METRIC_EXPORT_INTERVAL: "60000",
        };
        for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
        const on = await startTelemetry({ version: "1", env, exportTimeoutMs: 2000 });
        expect(on).toBe(true);
        await withSpan("a", { started: "ynm.a.started" }, async () => {});
        await shutdownTelemetry(5000);
      } finally {
        vi.unstubAllEnvs();
        server.close();
      }
      expect(seen.map((s) => s.path).sort()).toEqual(["/v1/logs", "/v1/metrics", "/v1/traces"]);
      expect(seen[0]?.type).toContain(protocol === "http/json" ? "json" : "protobuf");
    }
  );
});

describe("beginSpan", () => {
  it("is a no-op when off, and a span ended once by its caller when on", async () => {
    const closed = beginSpan("x", {});
    closed.set({ a: 1 });
    closed.end("ok");
    const t = await startMemoryTelemetry();
    await withSpan("outer", {}, async () => {
      const span = beginSpan("store scan", { kind: "client", started: "ynm.store.started" });
      span.set({ "ynm.record.count": 4 });
      span.end("error", "TypeError");
      span.end("ok");
    });
    const { spans } = await t.exported();
    const outer = spans.find((s) => s.name === "outer");
    expect(spans.find((s) => s.name === "store scan")).toMatchObject({
      kind: 2,
      parentSpanId: outer?.spanId,
      attributes: { "ynm.record.count": 4, "ynm.outcome": "error", "error.type": "TypeError" },
    });
  });
});
