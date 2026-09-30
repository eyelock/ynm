#!/usr/bin/env node
// Bundles the CLI and the MCP server into single files (after `pnpm build`):
//   dist-release/ynm.mjs  ESM, the slim tarball's program (runs on the user's Node)
//   dist-release/ynm.cjs  CommonJS, the main script of the single-executable binaries
// The guidance markdown is embedded with esbuild's text loader; oclif gets its package.json
// and command map in memory (scripts/release/entry.mjs). `node:*` builtins stay external.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const out = join(root, "dist-release");
mkdirSync(out, { recursive: true });

const cli = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8"));
const version = process.argv[2] ?? cli.version;
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
  logLevel: "warning",
};

await build({
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

await build({
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

console.log(`${join(out, "ynm.mjs")}\n${join(out, "ynm.cjs")}`);
