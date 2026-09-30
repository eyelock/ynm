#!/usr/bin/env node
// Builds the slim tarball (after `pnpm build`): `node scripts/release/build-slim.mjs [version]`.
// Output: dist-release/ynm_<version>_slim.tar.gz holding ynm.mjs (the ESM bundle), bin/ynm (a
// launcher that checks for Node 22.13 or later and execs it), LICENSE and README.md.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const out = join(root, "dist-release");
const version =
  process.argv[2] ??
  JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

run(process.execPath, [join(root, "scripts/release/bundle.mjs"), version]);

const name = `ynm_${version}_slim`;
const stage = join(out, name);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "bin"), { recursive: true });
copyFileSync(join(out, "ynm.mjs"), join(stage, "ynm.mjs"));
copyFileSync(join(root, "scripts/release/slim/ynm"), join(stage, "bin", "ynm"));
chmodSync(join(stage, "bin", "ynm"), 0o755);
copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));
copyFileSync(join(root, "README.md"), join(stage, "README.md"));

const archive = join(out, `${name}.tar.gz`);
run("tar", ["-czf", archive, "-C", stage, "ynm.mjs", "bin", "LICENSE", "README.md"]);
console.log(archive);
