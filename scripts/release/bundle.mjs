#!/usr/bin/env node
// Bundles the CLI and the MCP server into single files (after `pnpm build`):
//   dist-release/ynm.mjs  ESM, the slim tarball's program (runs on the user's Node)
//   dist-release/ynm.cjs  CommonJS, the main script of the single-executable binaries
// The guidance markdown is embedded with esbuild's text loader; oclif gets its package.json
// and command map in memory (scripts/release/entry.mjs). `node:*` builtins stay external.
//
// `--with-s3` is for the Docker image: it bundles @ynm/store-s3 and the AWS SDK into ynm.mjs
// (the image supports s3 mounts) and builds only the ESM file.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { checkTelemetryIsLazy } from "./lazy-telemetry.mjs";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const out = join(root, "dist-release");
const withS3 = process.argv.includes("--with-s3");
mkdirSync(out, { recursive: true });

const cli = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8"));
const version = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? cli.version;
const pjson = {
  name: cli.name,
  version,
  description: cli.description,
  type: cli.type,
  oclif: cli.oclif,
};

const common = {
  entryPoints: [join(root, "scripts/release/entry.mjs")],
  bundle: true,
  platform: "node",
  target: "node22",
  minify: true,
  legalComments: "none",
  loader: { ".md": "text" },
  // The entry sits outside the CLI package; resolve its bare imports as the CLI would.
  nodePaths: [join(root, "packages/cli/node_modules")],
  // The s3 provider and the AWS SDK stay out of the bundles: the service imports @ynm/store-s3
  // only when a mount asks for it, and here that import gets a stub that reports it missing.
  // The Docker image (--with-s3) keeps the real provider.
  alias: withS3 ? {} : { "@ynm/store-s3": join(root, "scripts/release/no-store-s3.mjs") },
  logLevel: "warning",
  // Read to prove the OpenTelemetry SDK is loaded only when telemetry starts.
  metafile: true,
};

const esm = await build({
  ...common,
  format: "esm",
  outfile: join(out, "ynm.mjs"),
  define: { YNM_PJSON: JSON.stringify(pjson) },
  // Bundled CommonJS dependencies (oclif) call require() for builtins.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __ynmCreateRequire } from "node:module";',
      "const require = __ynmCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

const cjs = withS3
  ? undefined
  : await build({
      ...common,
      format: "cjs",
      outfile: join(out, "ynm.cjs"),
      // CommonJS has no import.meta; point both at this file (the executable, inside a SEA).
      define: {
        YNM_PJSON: JSON.stringify(pjson),
        "import.meta.url": "__ynm_import_meta_url",
        "import.meta.dirname": "__ynm_import_meta_dirname",
      },
      banner: {
        js: [
          'const __ynm_import_meta_url = require("node:url").pathToFileURL(__filename).href;',
          'const __ynm_import_meta_dirname = require("node:path").dirname(__filename);',
        ].join("\n"),
      },
    });

for (const bundle of [esm, cjs]) {
  if (bundle) checkTelemetryIsLazy(bundle.metafile, "scripts/release/entry.mjs");
}

console.log([join(out, "ynm.mjs"), ...(withS3 ? [] : [join(out, "ynm.cjs")])].join("\n"));
