import { spawn } from "node:child_process";
import { ModelUnavailableError } from "../types.js";
import { type RawCompletion, ValidatingWriter } from "./base.js";

export interface ClaudeCliOptions {
  model?: string;
  /** Command to run; default `claude`. */
  command?: string;
  timeoutMs?: number;
}

/**
 * Writer over Claude Code headless (`claude -p --output-format json`): uses the user's own
 * Claude session, no API key. Slow (seconds per call) but always available where Claude Code is.
 */
export class ClaudeCliWriter extends ValidatingWriter {
  readonly name = "claude-cli";
  constructor(private readonly opts: ClaudeCliOptions = {}) {
    super();
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
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
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
