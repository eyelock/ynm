import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_YNM_MODEL_PROVIDER,
  EVENT_YNM_MODEL_STARTED,
  METRIC_YNM_MODEL_CALL_DURATION,
  type SpanHandle,
  withSpan,
} from "@ynm/telemetry";

/**
 * Runs one call out to a model as a client span (ADR-018), `model {provider}`, carrying the
 * provider and the model asked for, never the prompt or the answer. A CLI spawned inside it is
 * given this span's trace context; an HTTP request sent inside it carries the trace headers.
 * With telemetry off this is `fn()`.
 */
export function modelCall<T>(
  provider: string,
  model: string | undefined,
  operation: string | undefined,
  fn: (span: SpanHandle) => Promise<T>
): Promise<T> {
  return withSpan(
    `model ${provider}`,
    {
      kind: "client",
      started: EVENT_YNM_MODEL_STARTED,
      metric: METRIC_YNM_MODEL_CALL_DURATION,
      attributes: {
        [ATTR_YNM_MODEL_PROVIDER]: provider,
        [ATTR_GEN_AI_OPERATION_NAME]: operation,
        [ATTR_GEN_AI_REQUEST_MODEL]: model,
      },
    },
    fn
  );
}
