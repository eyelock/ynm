import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ClaudeCliWriter } from "./claude-cli.js";

// A real child process, but a tiny script standing in for `claude`: it answers with whether the
// key is present in its environment (never the value). No network, no real CLI.
const SCRIPT = `#!/usr/bin/env node
const result = JSON.stringify({
  hasKey: "ANTHROPIC_API_KEY" in process.env,
  traffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  marker: process.env.PASSTHROUGH_MARKER,
});
process.stdout.write(JSON.stringify({ result }));
`;

const schema = z.object({
  hasKey: z.boolean(),
  traffic: z.string(),
  marker: z.string(),
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
    expect(r.value).toEqual({ hasKey: false, traffic: "1", marker: "kept" });
  });

  it("keeps ANTHROPIC_API_KEY when useApiKey is true", async () => {
    const r = await new ClaudeCliWriter({ command, useApiKey: true }).write(req);
    expect(r.value).toEqual({ hasKey: true, traffic: "1", marker: "kept" });
  });
});
