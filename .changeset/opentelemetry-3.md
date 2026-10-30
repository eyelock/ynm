---
"@ynm/telemetry": patch
---

Telemetry runs on OpenTelemetry 3: the API at 1.10, the SDK at 3.0, the OTLP exporters at 0.300, and the ynr spool exporter at 0.3.0. The logs API now comes from `@opentelemetry/api`, so `@opentelemetry/api-logs` is gone. What ynm sends, and where, is unchanged.
