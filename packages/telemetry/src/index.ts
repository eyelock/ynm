/**
 * @ynm/telemetry: OpenTelemetry for ynm (ADR-018). Importing this loads no @opentelemetry
 * module; `startTelemetry` loads the SDK only when the environment asks for telemetry.
 */
export * from "./registry.gen.js";
export * from "./telemetry.js";
