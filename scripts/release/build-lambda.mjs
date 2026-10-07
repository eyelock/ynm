#!/usr/bin/env node
// Builds the AWS Lambda package (after `pnpm build`):
//   node scripts/release/build-lambda.mjs [--out dist/lambda.zip]
// esbuild bundles packages/mcp/src/lambda.ts (through scripts/release/lambda-entry.mjs, which
// embeds the guidance) into one ESM file for the nodejs24.x runtime; the zip holds `index.mjs`
// exporting `handler`, so the function's handler setting is `index.handler`. Pure JavaScript:
// the same zip runs on arm64 and x86_64. `node:*` builtins, `node:sqlite` included, stay external.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { checkTelemetryIsLazy } from "./lazy-telemetry.mjs";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const outIndex = process.argv.indexOf("--out");
const zip = resolve(root, outIndex >= 0 ? process.argv[outIndex + 1] : "dist/lambda.zip");
const stage = join(root, "dist-release", "lambda");

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(dirname(zip), { recursive: true });

const { metafile } = await build({
  entryPoints: [join(root, "scripts/release/lambda-entry.mjs")],
  outfile: join(stage, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  minify: true,
  legalComments: "none",
  loader: { ".md": "text" },
  // The entry sits outside the MCP package; resolve its bare imports as that package would.
  nodePaths: [join(root, "packages/mcp/node_modules")],
  logLevel: "warning",
  metafile: true,
  // Bundled CommonJS dependencies call require() for builtins.
  banner: {
    js: [
      'import { createRequire as __ynmCreateRequire } from "node:module";',
      "const require = __ynmCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

checkTelemetryIsLazy(metafile, "scripts/release/lambda-entry.mjs");

rmSync(zip, { force: true });
// -X: no extra file attributes, so the archive depends on the bundle alone.
const r = spawnSync("zip", ["-q", "-X", zip, "index.mjs"], { cwd: stage, stdio: "inherit" });
if (r.status !== 0) {
  console.error(`zip failed (${r.status ?? r.signal}); is zip installed?`);
  process.exit(r.status ?? 1);
}
console.log(`${zip} (${(statSync(zip).size / 1024 / 1024).toFixed(2)} MB)`);
