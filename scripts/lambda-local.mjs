#!/usr/bin/env node
// Serves a built Lambda package on localhost, so an MCP client (Claude Code, the inspector, curl)
// can talk to the exact code that runs on AWS:
//   node scripts/lambda-local.mjs [dist/lambda.zip]        (make lambda-local builds first)
// Each HTTP request becomes the Function URL event (payload 2.0) the AWS runtime would send, and
// the handler's result becomes the response. One process is one warm instance; restart it for a
// cold start. Configuration is the function's environment, from this shell:
//   PORT (default 3000), YNM_PUBLIC_URL (default http://localhost:$PORT/mcp), YNM_MOUNTS
//   (default: a sqlite store under .lambda-local/), YNM_MCP_TOKEN / YNM_JWKS_URL / … for auth,
//   and the AWS variables when a mount uses the s3 provider (`eval "$(make minio-env)"`).
// LAMBDA_EVENT='{"ynm":"dream"}' (or compact, health) sends that one scheduled event instead,
// prints the result and exits.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const zip = resolve(process.argv[2] ?? join(root, "dist/lambda.zip"));
const port = Number(process.env.PORT ?? 3000);
const timeoutMs = 30_000; // the function timeout infra/aws sets

const local = join(root, ".lambda-local");
mkdirSync(local, { recursive: true });
process.env.YNM_PUBLIC_URL ??= `http://localhost:${port}/mcp`;
process.env.YNM_HOME ??= join(local, "home");
process.env.YNM_MOUNTS ??= JSON.stringify([
  { id: "hosted", level: "distributed", provider: "sqlite", path: join(local, "store.sqlite") },
]);

const code = mkdtempSync(join(tmpdir(), "ynm-lambda-local-"));
const unzip = spawnSync("unzip", ["-q", zip, "-d", code], { stdio: "inherit" });
if (unzip.status !== 0) {
  console.error(`could not unzip ${zip}; run make lambda first`);
  process.exit(1);
}
const { handler } = await import(pathToFileURL(join(code, "index.mjs")).href);

// One scheduled event (what EventBridge Scheduler sends), then exit.
if (process.env.LAMBDA_EVENT) {
  const result = await handler(JSON.parse(process.env.LAMBDA_EVENT), {
    getRemainingTimeInMillis: () => timeoutMs,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url ?? "/", "http://localhost");
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k !== "cookie" && v !== undefined) headers[k] = Array.isArray(v) ? v.join(",") : v;
  }
  const event = {
    version: "2.0",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    cookies: req.headers.cookie ? req.headers.cookie.split(/;\s*/) : undefined,
    requestContext: {
      http: { method: req.method ?? "GET" },
      domainName: req.headers.host ?? `localhost:${port}`,
    },
    ...(chunks.length
      ? { body: Buffer.concat(chunks).toString("base64"), isBase64Encoded: true }
      : {}),
  };
  const started = Date.now();
  try {
    const result = await handler(event, {
      getRemainingTimeInMillis: () => timeoutMs - (Date.now() - started),
    });
    const out = { ...result.headers };
    if (result.cookies?.length) out["set-cookie"] = result.cookies;
    res.writeHead(result.statusCode, out);
    res.end(Buffer.from(result.body ?? "", result.isBase64Encoded ? "base64" : "utf8"));
  } catch (err) {
    // The AWS runtime answers a thrown error with a 502; do the same.
    console.error(err);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Internal Server Error" }));
  }
  console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Lambda package ${zip}`);
  console.log(`serving on http://localhost:${port}/mcp (YNM_PUBLIC_URL ${process.env.YNM_PUBLIC_URL})`);
  console.log(`mounts ${process.env.YNM_MOUNTS}`);
});
