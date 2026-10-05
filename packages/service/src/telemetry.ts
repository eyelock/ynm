import type { RecordLog, ShardFilter } from "@ynm/store";
import {
  ATTR_YNM_LEVEL,
  ATTR_YNM_MOUNT,
  ATTR_YNM_NAMESPACE,
  ATTR_YNM_RECORD_COUNT,
  ATTR_YNM_STORE_OPERATION,
  ATTR_YNM_STORE_PROVIDER,
  type Attributes,
  beginSpan,
  EVENT_YNM_STORE_STARTED,
  METRIC_YNM_STORE_OPERATION_DURATION,
  type SpanHandle,
  type SpanOptions,
  telemetryEnabled,
  withSpan,
} from "@ynm/telemetry";

type Operation = "append" | "scan" | "purge" | "sync" | "read_document" | "write_document";

const errorTypeOf = (err: unknown) => (err instanceof Error ? err.name || "Error" : typeof err);

/**
 * A record log whose calls are client spans (ADR-018): one per append, scan, purge, sync and
 * document read or write, carrying the mount, provider, level and record count, never a record.
 * Everything else, and every call's result, passes through untouched. Without telemetry the log
 * is returned as is, so a process with telemetry off runs exactly the code it always did.
 */
export function instrumentLog<L extends RecordLog>(log: L): L {
  if (!telemetryEnabled()) return log;
  const options = (op: Operation, more: Attributes = {}): SpanOptions => ({
    kind: "client",
    started: EVENT_YNM_STORE_STARTED,
    metric: METRIC_YNM_STORE_OPERATION_DURATION,
    attributes: {
      [ATTR_YNM_STORE_OPERATION]: op,
      [ATTR_YNM_STORE_PROVIDER]: log.provider,
      [ATTR_YNM_MOUNT]: log.id,
      [ATTR_YNM_LEVEL]: log.level,
      ...more,
    },
  });
  const call = <T>(op: Operation, fn: (s: SpanHandle) => Promise<T>, more?: Attributes) =>
    withSpan(`store ${op}`, options(op, more), fn);

  /** A scan is streamed, so its span is ended by the iteration, not by a returned promise. */
  async function* scan(
    original: RecordLog["scan"],
    filter?: ShardFilter,
    onProblem?: Parameters<RecordLog["scan"]>[1]
  ) {
    const span = beginSpan(
      "store scan",
      options("scan", { [ATTR_YNM_NAMESPACE]: filter?.namespace })
    );
    let n = 0;
    let failed: string | undefined;
    try {
      for await (const record of original.call(log, filter, onProblem)) {
        n += 1;
        yield record;
      }
    } catch (err) {
      failed = errorTypeOf(err);
      throw err;
    } finally {
      // Also reached when the consumer stops early: what it read is what the scan did.
      span.set({ [ATTR_YNM_RECORD_COUNT]: n });
      span.end(failed ? "error" : "ok", failed);
    }
  }

  return new Proxy(log, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      switch (prop) {
        case "append":
          return (records: readonly unknown[]) =>
            call("append", () => fn.call(target, records) as Promise<unknown>, {
              [ATTR_YNM_RECORD_COUNT]: records.length,
            });
        case "scan":
          return (filter?: ShardFilter, onProblem?: Parameters<RecordLog["scan"]>[1]) =>
            scan(fn as RecordLog["scan"], filter, onProblem);
        case "purge":
          return (...args: unknown[]) =>
            call("purge", async (s) => {
              const r = (await fn.apply(target, args)) as { removed: number };
              s.set({ [ATTR_YNM_RECORD_COUNT]: r.removed });
              return r;
            });
        case "sync":
          return (...args: unknown[]) =>
            call("sync", () => fn.apply(target, args) as Promise<unknown>);
        case "readDocument":
          return (...args: unknown[]) =>
            call("read_document", () => fn.apply(target, args) as Promise<unknown>);
        case "writeDocument":
          return (...args: unknown[]) =>
            call("write_document", () => fn.apply(target, args) as Promise<unknown>);
        default:
          return fn.bind(target);
      }
    },
  });
}
