import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bin, testEnv, ynm } from "./helpers.js";

const recorder = fileURLToPath(new URL("./fixtures/record-otel-modules.mjs", import.meta.url));

/** The environment with every OTEL_* variable removed: telemetry off, whatever the shell has. */
function withoutOtel(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = testEnv(extra);
  for (const key of Object.keys(env))
    if (key.startsWith("OTEL_") && !(key in extra)) delete env[key];
  return env;
}

/** Runs the CLI with the module recorder and returns its result and every OpenTelemetry module it loaded. */
function traced(cwd: string, env: NodeJS.ProcessEnv, args: string[], input = "") {
  const out = join(mkdtempSync(join(tmpdir(), "ynm-otel-modules-")), "modules.json");
  const started = Date.now();
  const r = spawnSync(process.execPath, ["--import", recorder, bin, ...args], {
    cwd,
    encoding: "utf8",
    input,
    env: { ...env, YNM_TEST_MODULES_OUT: out },
    timeout: 30_000,
  });
  const modules = JSON.parse(readFileSync(out, "utf8")) as string[];
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    modules,
    ms: Date.now() - started,
  };
}

describe("telemetry off loads nothing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ynm-otel-cli-"));
  const off = withoutOtel();

  it.each([
    ["--version"],
    ["status"],
    ["remember", "--type", "semantic", "--content", "telemetry stays off"],
    ["recall", "--text", "telemetry"],
  ])("ynm %s loads no @opentelemetry module", (...args) => {
    const r = traced(cwd, off, args);
    expect(r.status, r.stderr).toBe(0);
    expect(r.modules).toEqual([]);
  });

  it("ynm hook loads no @opentelemetry module", () => {
    const input = JSON.stringify({ session_id: "s", cwd, hook_event_name: "SessionStart" });
    const r = traced(cwd, off, ["hook", "session-start"], input);
    expect(r.status).toBe(0);
    expect(r.modules).toEqual([]);
  });

  it("ynm serve over stdio loads no @opentelemetry module", () => {
    const send = (id: number, method: string, params: unknown) =>
      JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const input = [
      send(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      }),
      "",
    ].join("\n");
    const r = traced(cwd, off, ["serve"], input);
    expect(r.stdout).toContain('"id":1');
    expect(r.modules).toEqual([]);
  });

  it("with an OTLP endpoint, the SDK loads, and exit codes and output are unchanged", () => {
    // Port 9 (discard) is closed: every export fails, which must cost the command nothing.
    const on = withoutOtel({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" });
    const loaded = traced(cwd, on, ["status", "--json"]);
    expect(loaded.status).toBe(0);
    expect(loaded.modules.length).toBeGreaterThan(0);
    expect(loaded.ms).toBeLessThan(15_000);
    expect(JSON.parse(loaded.stdout).name).toBe("ynm");
    for (const args of [["forget", "--memory-id", "01XXXXXXXXXXXXXXXXXXXXXXXX"], ["nope"]]) {
      const a = traced(cwd, off, args);
      const b = traced(cwd, on, args);
      expect(a.status).not.toBe(0);
      expect(b.status).toBe(a.status);
      expect(b.stdout).toBe(a.stdout);
    }
  });
});

describe("ynm telemetry registry", () => {
  it("prints the registry as JSON, identified by the tool's name and version", () => {
    const r = ynm(
      mkdtempSync(join(tmpdir(), "ynm-reg-")),
      "telemetry",
      "registry",
      "--format",
      "json"
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      tool: string;
      version: string;
      registry: { name: string; semconv_version: string; groups: Array<{ id: string }> };
    };
    expect(out.tool).toBe("ynm");
    expect(out.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(out.registry.name).toBe("ynm");
    expect(out.registry.groups.map((g) => g.id)).toContain("span.ynm.tool.call");
  });
});
