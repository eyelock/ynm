import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSpool } from "@ynm/telemetry/testing";
import { ynm, ynmWith, ynmWithInput } from "./helpers.js";

/** ynm's release is the CLI's package version; every place that reports a version reports it. */
const release = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

describe("one version everywhere (ynm #132)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ynm-version-"));

  it("ynm --version, the registry, serverInfo and telemetry's service.version all report the CLI's release", () => {
    expect(ynm(cwd, "--version").stdout).toContain(`@ynm/cli/${release} `);

    const registry = ynm(cwd, "telemetry", "registry", "--format", "json");
    expect(registry.status, registry.stderr).toBe(0);
    expect((JSON.parse(registry.stdout) as { version: string }).version).toBe(release);

    const init = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    })}\n`;
    const served = ynmWithInput(cwd, init, "serve", "--cwd", cwd, "--no-personal");
    expect(served.status, served.stderr).toBe(0);
    const reply = JSON.parse(served.stdout.trim().split("\n")[0] as string) as {
      result?: { serverInfo?: { version?: string } };
    };
    expect(reply.result?.serverInfo?.version).toBe(release);

    const spool = join(mkdtempSync(join(tmpdir(), "ynm-version-spool-")), "local");
    const r = ynmWith(
      cwd,
      { env: { YNR_SPOOL: spool } },
      "remember",
      "--type",
      "semantic",
      "--content",
      "versioned"
    );
    expect(r.status, r.stderr).toBe(0);
    // Every line of the spool is OTLP JSON whose resource names the version.
    const lines = readSpool(spool).text.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const versions = [
        ...line.matchAll(/"key":"service\.version","value":\{"stringValue":"([^"]*)"/g),
      ].map((m) => m[1]);
      expect(versions.length, line.slice(0, 120)).toBeGreaterThan(0);
      for (const v of versions) expect(v).toBe(release);
    }
  });
});
