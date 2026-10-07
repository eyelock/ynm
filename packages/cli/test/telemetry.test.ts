import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSpool } from "@ynm/telemetry/testing";
import { bin, testEnv, ynm } from "./helpers.js";

const recorder = fileURLToPath(new URL("./fixtures/record-otel-modules.mjs", import.meta.url));

/**
 * The environment with every OTEL_* variable and the ynr spool removed: telemetry off, whatever
 * the shell has (the test config points XDG_STATE_HOME at a folder that does not exist).
 */
function withoutOtel(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = testEnv(extra);
  for (const key of Object.keys(env))
    if ((key.startsWith("OTEL_") || key === "YNR_SPOOL") && !(key in extra)) delete env[key];
  return env;
}

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT = "00f067aa0ba902b7";
const isSpoolModule = (url: string) => /[\\/]@eyelock[\\/]otel-spool-exporter[\\/]/.test(url);

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

  it("ynm remember in a git repository, which runs git, loads no @opentelemetry module", () => {
    const repo = mkdtempSync(join(tmpdir(), "ynm-otel-git-"));
    const g = (...args: string[]) =>
      spawnSync("git", [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-C",
        repo,
        ...args,
      ]);
    g("init", "-q", "-b", "main");
    g("commit", "-q", "--allow-empty", "-m", "first");
    const r = traced(repo, off, ["remember", "--type", "semantic", "--content", "no spans here"]);
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

describe("telemetry to a ynr spool", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ynm-otel-spool-cli-"));

  it("writes each command's span, events and metrics as OTLP JSON lines, joining TRACEPARENT", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ynm-spool-")), "local");
    const env = withoutOtel({ YNR_SPOOL: dir, TRACEPARENT: `00-${TRACE}-${PARENT}-01` });
    const r = traced(cwd, env, ["remember", "--type", "semantic", "--content", "spooled"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.modules.some(isSpoolModule)).toBe(true);
    const spooled = readSpool(dir);
    // Closed on exit: no file is left open.
    expect(spooled.files.length).toBeGreaterThan(0);
    expect(spooled.files.every((f) => /^ynm-[\w-]+-\d+\.jsonl$/.test(f))).toBe(true);
    const command = spooled.spans.find((s) => s.name === "ynm remember");
    expect(command).toMatchObject({ traceId: TRACE, parentSpanId: PARENT });
    expect(spooled.spans.find((s) => s.name === "store append")).toMatchObject({
      traceId: TRACE,
      kind: 3,
    });
    expect(spooled.events).toEqual(
      expect.arrayContaining(["ynm.command.started", "ynm.store.started"])
    );
    expect(spooled.metrics).toEqual(
      expect.arrayContaining(["ynm.command.duration", "ynm.telemetry.spool.dropped"])
    );
    expect(spooled.text).not.toContain("spooled");
  });

  it("ynm hook stays silent and loads nothing, even with a spool", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ynm-spool-")), "local");
    const input = JSON.stringify({ session_id: "s", cwd, hook_event_name: "SessionStart" });
    const r = traced(cwd, withoutOtel({ YNR_SPOOL: dir }), ["hook", "session-start"], input);
    expect(r.status).toBe(0);
    expect(r.modules).toEqual([]);
    expect(readSpool(dir).files).toEqual([]);
  });

  it("an unwritable spool changes no exit code and no output", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ynm-spool-")), "not-a-folder");
    writeFileSync(file, "");
    const off = withoutOtel();
    const broken = withoutOtel({ YNR_SPOOL: join(file, "local") });
    const ok = traced(cwd, broken, ["status", "--json"]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.modules.some(isSpoolModule)).toBe(true);
    expect(ok.ms).toBeLessThan(15_000);
    expect(JSON.parse(ok.stdout).name).toBe("ynm");
    for (const args of [["forget", "--memory-id", "01XXXXXXXXXXXXXXXXXXXXXXXX"], ["nope"]]) {
      const a = traced(cwd, off, args);
      const b = traced(cwd, broken, args);
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
      semantic_conventions: { name: string; version: string; schema_url: string };
      attributes: Array<{ id: string; type: string }>;
      standard_attributes: string[];
      spans: Array<{ name: string; kind: string }>;
      metrics: Array<{ attributes: Array<{ name: string; cardinality?: number }> }>;
    };
    expect(out.tool).toBe("ynm");
    expect(out.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(out.semantic_conventions).toEqual({
      name: "otel",
      version: "1.43.0",
      schema_url: "https://opentelemetry.io/schemas/1.43.0",
    });
    expect(out.attributes.find((a) => a.id === "ynm.outcome")?.type).toBe("enum");
    expect(out.spans.find((s) => s.name === "ynm.tool.call")?.kind).toBe("server");
    expect(out.standard_attributes).toEqual([...out.standard_attributes].sort());
    expect(out.standard_attributes.some((id) => id.startsWith("ynm."))).toBe(false);
    expect(out.metrics.flatMap((m) => m.attributes).every((a) => a.cardinality)).toBe(true);
  });
});
