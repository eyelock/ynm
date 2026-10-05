import { Command, Flags } from "@oclif/core";
import { MCP_VERSION } from "@ynm/mcp";
import { DEFAULT_REDACTION, openYnm, RedactionError } from "@ynm/service";
import {
  ATTR_YNM_COMMAND_NAME,
  EVENT_YNM_COMMAND_STARTED,
  METRIC_YNM_COMMAND_DURATION,
  shutdownTelemetry,
  startTelemetry,
  withSpan,
} from "@ynm/telemetry";
import { InvalidInputError } from "./flags.js";

/** Commands with no command span: `serve` is a server with spans of its own, `hook` must stay fast. */
const UNTRACED = new Set(["serve", "hook"]);
/** The longest telemetry may hold a finished command open when its collector is down. */
const EXIT_BOUND_MS = 2000;

/** `since: expected an ISO 8601 date-time`, one clause per issue, instead of the raw issue list. */
function describeZodError(err: Error): string {
  const issues = (err as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues;
  if (!issues?.length) return err.message;
  return issues
    .map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
    .join("; ");
}

/** Shared behaviour: --json everywhere, one way to open the service, uniform errors. */
export abstract class YnmCommand extends Command {
  static baseFlags = {
    json: Flags.boolean({ description: "Output as JSON", default: false }),
    cwd: Flags.string({ description: "Run as if from this directory", helpGroup: "GLOBAL" }),
  };

  protected async open(flags: { cwd?: string }) {
    return openYnm({ cwd: flags.cwd });
  }

  protected emit(json: boolean, value: unknown, human: () => string): void {
    this.log(json ? JSON.stringify(value, null, 2) : human());
  }

  /** On stderr, so JSON output stays parseable: a hosted store a read could not include, and why. */
  protected noteLeftOut(ynm: { remoteIssues: Map<string, string> }): void {
    for (const why of ynm.remoteIssues.values()) this.logToStderr(`shared memory left out: ${why}`);
  }

  /**
   * With telemetry on, the command runs as one span that joins the TRACEPARENT it was started
   * with, and what is buffered is flushed, for at most two seconds, before the process exits
   * (ADR-018). With it off, nothing is loaded and the command runs as it always has. Errors and
   * exit codes pass through unchanged.
   */
  protected override async _run<T>(): Promise<T> {
    const id = this.id ?? "";
    if (
      UNTRACED.has(id) ||
      !(await startTelemetry({
        version: MCP_VERSION,
        redaction: DEFAULT_REDACTION,
        exportTimeoutMs: EXIT_BOUND_MS,
      }))
    )
      return super._run<T>();
    try {
      return await withSpan(
        `ynm ${id}`,
        {
          started: EVENT_YNM_COMMAND_STARTED,
          metric: METRIC_YNM_COMMAND_DURATION,
          attributes: { [ATTR_YNM_COMMAND_NAME]: id },
        },
        async (span) => {
          const result = await super._run<T>();
          // A command that fails without throwing sets the exit code instead.
          if (process.exitCode && process.exitCode !== 0) span.outcome("error");
          return result;
        }
      );
    } finally {
      await shutdownTelemetry(EXIT_BOUND_MS);
    }
  }

  protected override async catch(err: Error & { exitCode?: number }): Promise<unknown> {
    if (err instanceof RedactionError) this.error(`refused: ${err.message}`, { exit: 2 });
    if (err instanceof InvalidInputError) this.error(`invalid input: ${err.message}`, { exit: 2 });
    if (err.name === "ZodError") this.error(`invalid input: ${describeZodError(err)}`, { exit: 2 });
    return super.catch(err);
  }
}
