import { EventEmitter } from "node:events";
import { z } from "zod";
import { ModelUnavailableError, StructuredOutputError } from "../types.js";
import { ClaudeCliWriter, claudeCliEnv } from "./claude-cli.js";

/** A stand-in child process: the test scripts what it emits; nothing is ever executed. */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: string[] = [];
  /** When set, the child exits by signal (code null) as soon as it is killed, like a real one. */
  closeOnKill = false;
  kill(signal: string): boolean {
    this.kills.push(signal);
    if (this.closeOnKill) this.emit("close", null);
    return true;
  }
}

type Script = (child: FakeChild) => void;

const spawned: Array<{
  command: string;
  args: string[];
  env: Record<string, string>;
  child: FakeChild;
}> = [];
let scripts: Script[] = [];
let hangNext = false;

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], opts: { env: Record<string, string> }) => {
    const child = new FakeChild();
    child.closeOnKill = hangNext;
    hangNext = false;
    const script = scripts.shift();
    spawned.push({ command, args, env: opts.env, child });
    if (script) setImmediate(() => script(child));
    return child;
  },
}));

/** Emits stdout in two chunks (to exercise accumulation) then closes with the code. */
function exits(code: number | null, stdout = "", stderr = ""): Script {
  return (child) => {
    const mid = Math.floor(stdout.length / 2);
    if (stdout) {
      child.stdout.emit("data", stdout.slice(0, mid));
      child.stdout.emit("data", stdout.slice(mid));
    }
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code);
  };
}

const schema = z.object({ ok: z.boolean() });
const req = { instructions: "say ok", state: { a: 1 }, schema };

beforeEach(() => {
  spawned.length = 0;
  scripts = [];
  hangNext = false;
});

describe("claudeCliEnv", () => {
  const base = { ANTHROPIC_API_KEY: "test-key", PATH: "/bin", HOME: "/h" };

  it("drops ANTHROPIC_API_KEY by default and passes everything else through", () => {
    const env = claudeCliEnv(base);
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/h");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("keeps the key when useApiKey is true", () => {
    const env = claudeCliEnv(base, { useApiKey: true });
    expect(env.ANTHROPIC_API_KEY).toBe("test-key");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("does not mutate the input", () => {
    claudeCliEnv(base);
    expect(base.ANTHROPIC_API_KEY).toBe("test-key");
  });
});

describe("ClaudeCliWriter environment (spawn mocked)", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it("does not hand ANTHROPIC_API_KEY to the child by default", async () => {
    scripts = [exits(0, JSON.stringify({ result: '{"ok":true}' }))];
    await new ClaudeCliWriter().write(req);
    expect("ANTHROPIC_API_KEY" in (spawned[0]?.env ?? {})).toBe(false);
    expect(spawned[0]?.env.PATH).toBe(process.env.PATH);
  });

  it("hands it over when useApiKey is set", async () => {
    scripts = [exits(0, JSON.stringify({ result: '{"ok":true}' }))];
    await new ClaudeCliWriter({ useApiKey: true }).write(req);
    expect("ANTHROPIC_API_KEY" in (spawned[0]?.env ?? {})).toBe(true);
  });
});

describe("ClaudeCliWriter (spawn mocked, no real CLI)", () => {
  it("runs claude headless with an empty MCP config and maps result, model and usage", async () => {
    scripts = [
      exits(
        0,
        JSON.stringify({
          result: '{"ok":true}',
          model: "claude-test",
          usage: { input_tokens: 40, output_tokens: 3 },
        })
      ),
    ];
    const w = new ClaudeCliWriter();
    const r = await w.write(req);
    expect(r).toEqual({
      value: { ok: true },
      model: "claude-test",
      usage: { inputTokens: 40, outputTokens: 3 },
    });
    const call = spawned[0];
    expect(call?.command).toBe("claude");
    expect(call?.args[0]).toBe("-p");
    expect(call?.args[1]).toContain("say ok");
    expect(call?.args.slice(2)).toEqual([
      "--output-format",
      "json",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ]);
    expect(call?.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("passes the configured model and command, and falls back to the configured model name", async () => {
    scripts = [exits(0, JSON.stringify({ result: '{"ok":false}', usage: {} }))];
    const w = new ClaudeCliWriter({ model: "sonnet-x", command: "/opt/bin/claude" });
    const r = await w.write(req);
    expect(spawned[0]?.command).toBe("/opt/bin/claude");
    expect(spawned[0]?.args.slice(-2)).toEqual(["--model", "sonnet-x"]);
    expect(r.model).toBe("sonnet-x");
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(r.value).toEqual({ ok: false });
  });

  it("treats non-JSON stdout as the raw completion text", async () => {
    scripts = [exits(0, 'Here you go: {"ok":true}')];
    const r = await new ClaudeCliWriter().write(req);
    expect(r.value).toEqual({ ok: true });
    expect(r.model).toBe("claude-cli");
    expect(r.usage).toBeUndefined();
  });

  it("retries with the issue when raw output holds no complete JSON, then fails closed", async () => {
    // Unterminated envelope: falls back to raw text, which then fails extraction twice.
    scripts = [exits(0, '{"ok":true'), exits(0, "still not json")];
    const w = new ClaudeCliWriter({ model: "m1" });
    await expect(w.write(req)).rejects.toBeInstanceOf(StructuredOutputError);
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.args[1]).toContain(
      "Your previous answer was rejected: unterminated JSON in output"
    );
  });

  it("treats a missing result field as empty text and retries", async () => {
    scripts = [
      exits(0, JSON.stringify({ model: "m" })),
      exits(0, JSON.stringify({ result: '{"ok":true}' })),
    ];
    const r = await new ClaudeCliWriter().write(req);
    expect(r.value).toEqual({ ok: true });
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.args[1]).toContain("no JSON in output");
  });

  it("rejects a non-zero exit with the code and truncated stderr", async () => {
    scripts = [exits(2, "", `boom ${"x".repeat(400)}`)];
    const p = new ClaudeCliWriter().write(req);
    await expect(p).rejects.toBeInstanceOf(ModelUnavailableError);
    // stderr is cut to its first 300 characters.
    await expect(p).rejects.toThrow(
      `claude-cli unavailable: exit 2: ${`boom ${"x".repeat(400)}`.slice(0, 300)}`
    );
    await expect(p).rejects.not.toThrow("x".repeat(296));
  });

  it("rejects when the command cannot be spawned", async () => {
    scripts = [(child) => child.emit("error", new Error("spawn claude ENOENT"))];
    await expect(new ClaudeCliWriter().write(req)).rejects.toThrow(
      /claude-cli unavailable: spawn claude ENOENT/
    );
  });

  it("kills the child with SIGKILL on timeout and reports the signal exit", async () => {
    // No script: the child emits nothing and hangs until the timer kills it.
    hangNext = true;
    await expect(new ClaudeCliWriter({ timeoutMs: 5 }).write(req)).rejects.toThrow(/exit null/);
    expect(spawned[0]?.child.kills).toEqual(["SIGKILL"]);
  });
});
