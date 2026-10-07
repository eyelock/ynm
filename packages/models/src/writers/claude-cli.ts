import { spawn } from "node:child_process";
import { traceEnv } from "@ynm/telemetry";
import { ModelUnavailableError } from "../types.js";
import { type RawCompletion, ValidatingWriter } from "./base.js";

export interface ClaudeCliOptions {
  model?: string;
  /** Command to run; default `claude`. */
  command?: string;
  timeoutMs?: number;
  /**
   * Keep `ANTHROPIC_API_KEY` in the child's environment so the CLI runs on the API key instead
   * of the person's Claude Code login. Default false.
   */
  useApiKey?: boolean;
}

/** Claude Code settings that put prompt or tool content into its telemetry; never passed on. */
const CONTENT_LOGGING = ["OTEL_LOG_USER_PROMPTS", "OTEL_LOG_TOOL_DETAILS"] as const;

/**
 * The environment for a spawned `claude` CLI. The key is dropped by default because current
 * Claude Code exits 1 when `ANTHROPIC_API_KEY` is set alongside a login, and these callers want
 * the login. With telemetry on, `TRACEPARENT` (and `TRACESTATE`) name the active span, the model
 * call's, so the CLI's own telemetry nests under ynm's. Claude Code's content logging is always
 * off: a prompt here carries memory content, so an inherited `OTEL_LOG_USER_PROMPTS` or
 * `OTEL_LOG_TOOL_DETAILS` is dropped. Everything else passes through.
 */
export function claudeCliEnv(
  env: NodeJS.ProcessEnv,
  opts: { useApiKey?: boolean } = {}
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...traceEnv(env),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (!opts.useApiKey) delete out.ANTHROPIC_API_KEY;
  for (const key of CONTENT_LOGGING) delete out[key];
  return out;
}

/**
 * Writer over Claude Code headless (`claude -p --output-format json`): uses the user's own
 * Claude session, not an API key (`ANTHROPIC_API_KEY` is removed from the child unless `useApiKey`). Slow (seconds per call) but always available where Claude Code is.
 */
export class ClaudeCliWriter extends ValidatingWriter {
  readonly name = "claude-cli";
  constructor(private readonly opts: ClaudeCliOptions = {}) {
    super();
  }

  protected override model(): string | undefined {
    return this.opts.model;
  }

  protected complete(prompt: string): Promise<RawCompletion> {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ];
    if (this.opts.model) args.push("--model", this.opts.model);
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.command ?? "claude", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: claudeCliEnv(process.env, { useApiKey: this.opts.useApiKey }),
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), this.opts.timeoutMs ?? 180_000);
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        err += d;
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new ModelUnavailableError("claude-cli", e.message));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0)
          return reject(
            new ModelUnavailableError("claude-cli", `exit ${code}: ${err.slice(0, 300)}`)
          );
        try {
          const parsed = JSON.parse(out) as {
            result?: string;
            usage?: { input_tokens?: number; output_tokens?: number };
            model?: string;
          };
          resolve({
            text: String(parsed.result ?? ""),
            model: parsed.model ?? this.opts.model ?? "claude-cli",
            usage: parsed.usage
              ? {
                  inputTokens: parsed.usage.input_tokens ?? 0,
                  outputTokens: parsed.usage.output_tokens ?? 0,
                }
              : undefined,
          });
        } catch {
          resolve({ text: out, model: this.opts.model ?? "claude-cli" });
        }
      });
    });
  }
}
