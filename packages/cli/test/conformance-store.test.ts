import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { bin, testEnv } from "./helpers.js";

/**
 * ynr's rule 13 ("never write telemetry into memory") snapshots the scratch YNM_HOME it gives each
 * run. Every ynm scenario sets its own YNM_HOME inline, because ynm's scenarios write a canary
 * memory on purpose, so rule 13 reads a store nothing wrote to and passes vacuously (ynm #174).
 * `.ynr/conformance.yaml` records that exemption; this test is the check that takes its place: it
 * runs each scenario against a store it can read, and fails on any record that is not what the
 * scenario means to write.
 */
const file = fileURLToPath(new URL("../../../.ynr/conformance.yaml", import.meta.url));
const scenarios = (
  parse(readFileSync(file, "utf8")) as {
    scenarios: { name: string; run: string }[];
  }
).scenarios;

const OWN_HOME = 'YNM_HOME="$(mktemp -d)"';
const CANARY = "@canary:memory";
const TELEMETRY = /traceId|spanId|trace_id|span_id|gen_ai\.|otel|resourceSpans|telemetry/i;

/**
 * The environment a scenario runs in: testEnv without any OTEL_* of the developer's own, and with
 * the ynr spool on, as ynr's own runs have it. Telemetry is off unless one of these is set, so a
 * run without it could never put a span anywhere (ynm #174).
 */
function scenarioEnv(spool: string, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = testEnv(extra);
  for (const key of Object.keys(env)) if (key.startsWith("OTEL_")) delete env[key];
  return { ...env, YNR_SPOOL: spool };
}

/** What reached a spool folder: every file's text, so a run can show that telemetry was on. */
function spooled(spool: string): string {
  if (!existsSync(spool)) return "";
  return readdirSync(spool)
    .map((f) => readFileSync(join(spool, f), "utf8"))
    .join("\n");
}

type Rec = {
  op?: string;
  content?: string;
  summary?: string;
  tags?: string[];
  data?: { [key: string]: unknown };
};

/**
 * The records of a store that are not what a conformance scenario writes: a memory whose content is
 * the canary, and the dream's `dreamed` annotation. A telemetry-shaped record is named as such.
 */
function unexpectedRecords(exported: string): string[] {
  const bad: string[] = [];
  for (const line of exported.split("\n").filter((l) => l.trim())) {
    const r = JSON.parse(line) as Rec;
    const dream = r.op === "annotate" && Object.keys(r.data ?? {}).join() === "dreamed";
    const canary = r.op === "create" && r.content === CANARY && r.summary === CANARY;
    if (TELEMETRY.test(line)) bad.push(`telemetry in memory: ${r.op} record`);
    else if (!dream && !canary) bad.push(`unexpected ${r.op} record`);
  }
  return bad;
}

describe("the store ynm's conformance scenarios write to holds no telemetry (ynm #174)", () => {
  const root = mkdtempSync(join(tmpdir(), "ynm-store-"));
  const shim = join(root, "bin");

  beforeAll(() => {
    mkdirSync(shim);
    writeFileSync(join(shim, "ynm"), `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`);
    chmodSync(join(shim, "ynm"), 0o755);
  });

  /** Runs a scenario as conformance does, with telemetry on, and returns what it left in its store. */
  function runScenario(run: string, id: string): string[] {
    const home = join(root, `home-${id}`);
    const spool = join(root, `spool-${id}`, "local");
    const r = spawnSync("sh", ["-c", run.replace(OWN_HOME, `YNM_HOME="${home}"`)], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: scenarioEnv(spool, { PATH: `${shim}:${process.env.PATH}`, YNM_HOME: home }),
    });
    expect(r.status, r.stderr).toBe(0);
    // Telemetry was on: the run's spans reached the spool. Without this, a clean store proves nothing.
    expect(spooled(spool), "the scenario ran with telemetry off").toMatch(/"name":"ynm\./);
    const out = spawnSync(process.execPath, [bin, "export", "--cwd", root], {
      cwd: root,
      encoding: "utf8",
      env: testEnv({ YNM_HOME: home }),
    });
    expect(out.status, out.stderr).toBe(0);
    return unexpectedRecords(out.stdout);
  }

  it.each(scenarios.map((s, i) => [s.name, s.run, i]))(
    "%s leaves only what it means to write",
    (_name, run, i) => {
      expect(run, "a scenario must set its own YNM_HOME, as the exemption says").toContain(
        OWN_HOME
      );
      expect(runScenario(run as string, String(i))).toEqual([]);
    }
  );

  it("fails a scenario that, run with telemetry on, leaks its span into memory", () => {
    const leak = `${scenarios[0].run} && ynm remember --type semantic --content "$(cat "$YNR_SPOOL"/*.jsonl | head -1)"`;
    expect(runScenario(leak, "leak")).toEqual(["telemetry in memory: create record"]);
  });

  it("fails a store that holds a span-shaped memory", () => {
    const home = join(root, "home-broken");
    const env = testEnv({ YNM_HOME: home });
    const cwd = mkdtempSync(join(tmpdir(), "ynm-store-cwd-"));
    spawnSync(process.execPath, [bin, "remember", "--type", "semantic", "--content", CANARY], {
      cwd,
      env,
    });
    const span = JSON.stringify({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      name: "ynm.remember",
    });
    const r = spawnSync(
      process.execPath,
      [bin, "remember", "--type", "semantic", "--content", span],
      { cwd, env, encoding: "utf8" }
    );
    expect(r.status, r.stderr).toBe(0);
    const out = spawnSync(process.execPath, [bin, "export", "--cwd", cwd], {
      cwd,
      env,
      encoding: "utf8",
    });
    expect(unexpectedRecords(out.stdout)).toEqual(["telemetry in memory: create record"]);
  });
});
