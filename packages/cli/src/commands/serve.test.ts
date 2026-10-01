import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bin, testEnv, ynmWithInput } from "../../test/helpers.js";

const initialize = (protocolVersion: string) =>
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } },
  })}\n`;

describe("ynm serve", () => {
  const dir = mkdtempSync(join(tmpdir(), "ynm-serve-"));

  it("serves MCP over stdio and exits when stdin closes", () => {
    const r = ynmWithInput(dir, initialize("2025-06-18"), "serve", "--cwd", dir, "--no-personal");
    expect(r.status, r.stderr).toBe(0);
    const reply = JSON.parse(r.stdout.trim().split("\n")[0] as string) as {
      result?: { serverInfo?: { name: string } };
    };
    expect(reply.result?.serverInfo?.name).toBeTruthy();
  });

  it("passes --modern-only through: a legacy client is rejected", () => {
    const r = ynmWithInput(dir, initialize("2025-06-18"), "serve", "--modern-only");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Unsupported protocol version/);
  });

  it("serves HTTP with every option until SIGTERM", async () => {
    const child = spawn(
      process.execPath,
      [
        bin,
        "serve",
        "--http",
        "--port",
        "0",
        "--host",
        "127.0.0.1",
        "--token",
        "t0ken",
        "--allow-origin",
        "http://localhost",
        "--allow-host",
        "127.0.0.1",
        "--no-personal",
        "--cwd",
        dir,
        "--dream-every",
        "1h",
        "--sync-every",
        "1h",
      ],
      { cwd: dir, env: testEnv(), stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderr = "";
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listen line: ${stderr}`)), 30_000);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => {
        stderr += d;
        const m = /health: (http:\/\/\S+?)\)/.exec(stderr);
        if (m && /ynm-mcp auth: bearer/.test(stderr)) {
          clearTimeout(timer);
          resolve(m[1] as string);
        }
      });
      child.on("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
    });
    const health = await fetch(url);
    expect(health.status).toBe(200);
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  });
});
