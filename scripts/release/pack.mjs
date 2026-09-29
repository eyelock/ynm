#!/usr/bin/env node
// Builds the release tarball: a self-contained `ynm` CLI (pnpm deploy of @ynm/cli, production
// deps only, workspace packages inlined). Output: dist-release/ynm-<version>.tar.gz + .sha256.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const version = process.argv[2] ?? JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
const out = join(root, "dist-release");
const stage = join(out, `ynm-${version}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run("pnpm", ["--filter", "@ynm/cli", "deploy", "--prod", stage]);
// A launcher that does not depend on a shebang or the caller's PATH order.
writeFileSync(join(stage, "ynm"), '#!/bin/sh\nexec node "$(dirname "$0")/bin/run.js" "$@"\n', { mode: 0o755 });
writeFileSync(join(stage, "VERSION"), `${version}\n`);
const tarball = join(out, `ynm-${version}.tar.gz`);
run("tar", ["-czf", tarball, "-C", out, `ynm-${version}`]);
const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
writeFileSync(`${tarball}.sha256`, `${sha}  ynm-${version}.tar.gz\n`);
console.log(`${tarball}\n${sha}`);
