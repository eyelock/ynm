import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMemoryTelemetry } from "@ynm/telemetry/testing";
import { z } from "zod";
import { ClaudeCliWriter } from "./claude-cli.js";

// A real child process, but a tiny script standing in for `claude`: it answers with whether the
// key is present in its environment (never the value). No network, no real CLI.
const SCRIPT = `#!/usr/bin/env node
const result = JSON.stringify({
  hasKey: "ANTHROPIC_API_KEY" in process.env,
  traffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  marker: process.env.PASSTHROUGH_MARKER,
  traceparent: process.env.TRACEPARENT ?? "none",
});
process.stdout.write(JSON.stringify({ result }));
`;

const schema = z.object({
  hasKey: z.boolean(),
  traffic: z.string(),
  marker: z.string(),
  traceparent: z.string(),
});
const req = { instructions: "report", state: {}, schema };

describe("ClaudeCliWriter spawning a fake command", () => {
  let dir: string;
  let command: string;
  const saved = { key: process.env.ANTHROPIC_API_KEY, marker: process.env.PASSTHROUGH_MARKER };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ynm-fake-claude-"));
    command = join(dir, "claude");
    writeFileSync(command, SCRIPT);
    chmodSync(command, 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.PASSTHROUGH_MARKER = "kept";
  });
  afterEach(() => {
    for (const [name, v] of [
      ["ANTHROPIC_API_KEY", saved.key],
      ["PASSTHROUGH_MARKER", saved.marker],
    ] as const) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  });

  it("runs without ANTHROPIC_API_KEY by default and keeps the rest of the environment", async () => {
    const r = await new ClaudeCliWriter({ command }).write(req);
    expect(r.value).toEqual({ hasKey: false, traffic: "1", marker: "kept", traceparent: "none" });
  });

  it("keeps ANTHROPIC_API_KEY when useApiKey is true", async () => {
    const r = await new ClaudeCliWriter({ command, useApiKey: true }).write(req);
    expect(r.value).toEqual({ hasKey: true, traffic: "1", marker: "kept", traceparent: "none" });
  });

  it("with telemetry on, is one client span whose context the CLI gets as TRACEPARENT", async () => {
    const t = await startMemoryTelemetry();
    try {
      const r = await new ClaudeCliWriter({ command, model: "sonnet" }).write(req);
      const { spans, text } = await t.exported();
      const span = spans.find((s) => s.name === "model claude-cli");
      expect(span).toMatchObject({
        kind: 2,
        attributes: {
          "ynm.model.provider": "claude-cli",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "sonnet",
          "ynm.outcome": "ok",
        },
      });
      expect(r.value.traceparent).toBe(`00-${span?.traceId}-${span?.spanId}-01`);
      // Never the prompt or the command's arguments.
      expect(text).not.toContain("report");
      expect(text).not.toContain("--output-format");
    } finally {
      await t.stop();
    }
  });
});
