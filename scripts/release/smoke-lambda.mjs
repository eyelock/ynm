#!/usr/bin/env node
// Smoke-tests a built Lambda package: `node scripts/release/smoke-lambda.mjs [dist/lambda.zip]`.
// Unpacks the zip, imports index.mjs as the Lambda runtime would, and calls `handler` with a
// scheduled health event, a Function URL GET /health, a request without a token (401), an MCP
// initialize, and the session-start prompt (embedded guidance), against a throwaway sqlite store.
// The bearer token is not in the environment: a fake Parameter Store serves it under
// YNM_SSM_ENV_PATH, so the cold-start secret loading is exercised too.
// Prints each step; exits 1 on the first failure.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const zip = resolve(process.argv[2] ?? join(root, "dist/lambda.zip"));
const scratch = mkdtempSync(join(tmpdir(), "ynm-lambda-smoke-"));
const code = join(scratch, "task");
mkdirSync(code);

let failed = false;
function step(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
  return ok;
}

const event = (method, rawPath, headers = {}, body) => ({
  version: "2.0",
  rawPath,
  rawQueryString: "",
  headers: { host: "smoke.lambda-url.eu-west-2.on.aws", ...headers },
  requestContext: { http: { method }, domainName: "smoke.lambda-url.eu-west-2.on.aws" },
  ...(body === undefined ? {} : { body: JSON.stringify(body), isBase64Encoded: false }),
});

// Just enough of SSM's JSON API for GetParametersByPath, with one page per parameter so the
// entry's pagination runs.
const ssmParams = [
  { Name: "/ynm/smoke/env/YNM_MCP_TOKEN", Value: "smoke-token" },
  { Name: "/ynm/smoke/env/ANTHROPIC_API_KEY", Value: "unset" },
];
const ssm = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const { Path, NextToken } = JSON.parse(body || "{}");
  const i = Number(NextToken ?? 0);
  const page = ssmParams.filter((p) => p.Name.startsWith(Path)).slice(i, i + 1);
  const more = i + 1 < ssmParams.length;
  res.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
  res.end(JSON.stringify({ Parameters: page, ...(more ? { NextToken: String(i + 1) } : {}) }));
});
await new Promise((r) => ssm.listen(0, "127.0.0.1", r));

try {
  const unzip = spawnSync("unzip", ["-q", zip, "-d", code], { stdio: "inherit" });
  if (!step("unzip", unzip.status === 0, zip)) process.exit(1);

  // Whatever this shell has must not stand in for what Parameter Store should supply.
  delete process.env.YNM_MCP_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  Object.assign(process.env, {
    YNM_PUBLIC_URL: "https://memory.example.com/mcp",
    YNM_HOME: join(scratch, "home"),
    YNM_USER: "smoke",
    YNM_SSM_ENV_PATH: "/ynm/smoke/env/",
    AWS_ENDPOINT_URL_SSM: `http://127.0.0.1:${ssm.address().port}`,
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "smoke",
    AWS_SECRET_ACCESS_KEY: "smoke",
    YNM_MOUNTS: JSON.stringify([
      { id: "team", level: "distributed", provider: "sqlite", path: join(scratch, "store.sqlite") },
    ]),
  });
  const { handler } = await import(pathToFileURL(join(code, "index.mjs")).href);
  step("index.mjs exports handler", typeof handler === "function");
  step(
    "secrets from Parameter Store",
    process.env.YNM_MCP_TOKEN === "smoke-token" && process.env.ANTHROPIC_API_KEY === undefined,
    "YNM_MCP_TOKEN set, the unset placeholder skipped"
  );

  const health = await handler({ ynm: "health" });
  step("scheduled health", health?.status === "ok", JSON.stringify(health));

  const http = await handler(event("GET", "/health"));
  step("GET /health without a token", http.statusCode === 200, http.body);

  const denied = await handler(event("POST", "/mcp", { "content-type": "application/json" }, {}));
  step(
    "POST /mcp without a token",
    denied.statusCode === 401 && /^Bearer/.test(denied.headers["www-authenticate"] ?? ""),
    `${denied.statusCode} ${denied.headers["www-authenticate"] ?? ""}`
  );

  const mcpHeaders = {
    authorization: "Bearer smoke-token",
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const init = await handler(
    event("POST", "/mcp", mcpHeaders, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "ynm-lambda-smoke", version: "0" },
      },
    })
  );
  step("initialize", init.statusCode === 200 && init.body.includes('"ynm"'), `${init.statusCode}`);

  const prompt = await handler(
    event(
      "POST",
      "/mcp",
      { ...mcpHeaders, "mcp-protocol-version": "2025-06-18" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "prompts/get",
        params: { name: "memory-session-start", arguments: {} },
      }
    )
  );
  step(
    "prompts/get memory-session-start",
    prompt.statusCode === 200 && prompt.body.includes("\"messages\"") && !prompt.body.includes("\"error\""),
    `${prompt.statusCode} ${prompt.body.length} bytes`
  );
} catch (err) {
  step("smoke", false, err instanceof Error ? err.stack : String(err));
} finally {
  ssm.close();
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
