#!/usr/bin/env node
// Smoke-tests a built ynm: `node scripts/release/smoke.mjs <version> <command> [args...]`, where
// the command is how to launch it (`dist-release/ynm_0.1.0_darwin_arm64/ynm`, or
// `node dist-release/ynm.mjs`). Runs --version, --help and serve --help, an init/remember/recall
// round trip in a throwaway YNM_HOME, and one MCP exchange over stdio (initialize, the
// session-start prompt, which is embedded guidance), and one command with telemetry on, whose spans
// must reach a local OTLP endpoint. Prints each step; exits 1 on the first failure.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Paths are resolved here, because every step runs in a scratch directory.
const [version, ...launch] = process.argv.slice(2).map((a, i) => (i > 0 && a.includes("/") ? resolve(a) : a));
const [cmd, ...pre] = launch;
if (!version || !cmd) {
  console.error("usage: smoke.mjs <version> <command> [args...]");
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "ynm-smoke-"));
const home = join(scratch, "home");
const work = join(scratch, "work");
mkdirSync(home);
mkdirSync(work);
const env = { ...process.env, HOME: home, YNM_HOME: join(home, ".ynm") };
delete env.YNM_CONFIG;
// Telemetry is off unless a step turns it on.
for (const key of Object.keys(env)) if (key.startsWith("OTEL_")) delete env[key];

let failed = false;
function step(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
  return ok;
}
function ynm(...args) {
  const r = spawnSync(cmd, [...pre, ...args], { cwd: work, env, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}
const first = (s) => s.trim().split("\n")[0];

try {
  const v = ynm("--version");
  step("--version", v.status === 0 && v.stdout.includes(`@ynm/cli/${version}`), first(v.out));
  const help = ynm("--help");
  step("--help", help.status === 0 && help.stdout.includes("remember"), `${help.stdout.length} bytes`);
  const serveHelp = ynm("serve", "--help");
  step("serve --help", serveHelp.status === 0, first(serveHelp.out));

  const init = ynm("init", "--personal");
  step("init --personal", init.status === 0, first(init.out));
  const content = "The release bundle embeds the guidance markdown";
  const rem = ynm("remember", "--type", "semantic", "--content", content, "--json");
  step("remember", rem.status === 0, rem.status === 0 ? `memoryId ${JSON.parse(rem.stdout).memoryId}` : first(rem.out));
  const rec = ynm("recall", "--text", "bundle guidance", "--json");
  step("recall", rec.status === 0 && rec.stdout.includes(content), `${rec.stdout.length} bytes`);

  const prompt = await mcpPrompt("memory-session-start");
  step("serve (stdio): prompts/get memory-session-start", /^# /.test(prompt ?? ""), first(prompt ?? "no reply"));

  const otlp = await withTelemetry("status");
  step(
    "status with telemetry on: spans reach the OTLP endpoint",
    otlp.status === 0 && otlp.paths.includes("/v1/traces"),
    `exit ${otlp.status}, ${otlp.paths.join(" ") || "no exports"}`
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

/**
 * Runs one command with OTEL_EXPORTER_OTLP_ENDPOINT set to a local endpoint and returns its exit
 * status and the paths it exported to: proof the bundled SDK loads when telemetry is on.
 */
async function withTelemetry(...args) {
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    req.resume();
    req.on("end", () => res.writeHead(200).end());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const status = await new Promise((resolve) => {
    const child = spawn(cmd, [...pre, ...args], {
      cwd: work,
      env: { ...env, OTEL_EXPORTER_OTLP_ENDPOINT: endpoint },
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code));
  });
  server.close();
  return { status, paths: [...new Set(paths)].sort() };
}

/** Starts `serve` on stdio, initializes, fetches one prompt, and returns its text. */
function mcpPrompt(name) {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...pre, "serve"], { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => done(undefined), 20_000);
    let buf = "";
    function done(value) {
      clearTimeout(timer);
      child.kill();
      resolve(value);
    }
    const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "prompts/get", params: { name, arguments: {} } });
        } else if (msg.id === 2) {
          done(msg.result?.messages?.[0]?.content?.text ?? JSON.stringify(msg.error ?? msg));
        }
      }
    });
    child.on("exit", () => done(undefined));
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "ynm-smoke", version },
      },
    });
  });
}
