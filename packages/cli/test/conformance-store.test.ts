import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  parse(readFileSync(file, "utf8")) as { scenarios: { name: string; run: string }[] }
).scenarios;

const OWN_HOME = 'YNM_HOME="$(mktemp -d)"';
const CANARY = "@canary:memory";
const TELEMETRY = /traceId|spanId|trace_id|span_id|gen_ai\.|otel|resourceSpans|telemetry/i;

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

  it.each(scenarios.map((s, i) => [s.name, s.run, i]))(
    "%s leaves only what it means to write",
    (_name, run, i) => {
      expect(run, "a scenario must set its own YNM_HOME, as the exemption says").toContain(
        OWN_HOME
      );
      const home = join(root, `home-${i}`);
      const r = spawnSync("sh", ["-c", (run as string).replace(OWN_HOME, `YNM_HOME="${home}"`)], {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
      });
      expect(r.status, r.stderr).toBe(0);
      const out = spawnSync(process.execPath, [bin, "export", "--cwd", root], {
        cwd: root,
        encoding: "utf8",
        env: testEnv({ YNM_HOME: home }),
      });
      expect(out.status, out.stderr).toBe(0);
      expect(unexpectedRecords(out.stdout)).toEqual([]);
    }
  );

  it("fails a scenario that writes telemetry into memory", () => {
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
