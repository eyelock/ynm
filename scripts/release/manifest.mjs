#!/usr/bin/env node
// Describes a release's assets: `node scripts/release/manifest.mjs <version> [dir]`.
// Reads ynm_<version>_<os>_<arch>.tar.gz, ynm_<version>_slim.tar.gz and, when present,
// ynm_<version>_lambda.zip from dir (default dist-release) and writes dir/manifest.json
// ({ version, assets: [{ file, kind, os, arch, sha256, bytes }] }) and dir/checksums.txt
// (sha256sum format, as goreleaser writes it).
// scripts/release/formula.mjs renders the Homebrew formulae from the manifest.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [version, dirArg] = process.argv.slice(2);
if (!version) {
  console.error("usage: manifest.mjs <version> [dir]");
  process.exit(2);
}
const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const dir = dirArg ? resolve(dirArg) : join(root, "dist-release");

const escaped = version.replace(/[.+]/g, "\\$&");
const pattern = new RegExp(
  `^ynm_${escaped}_(?:(?:(darwin|linux)_(arm64|amd64)|(slim))\\.tar\\.gz|(lambda)\\.zip)$`
);
const assets = readdirSync(dir)
  .sort()
  .flatMap((file) => {
    const m = pattern.exec(file);
    if (!m) return [];
    const bytes = readFileSync(join(dir, file));
    return [
      {
        file,
        kind: m[1] ? "standalone" : (m[3] ?? m[4]),
        os: m[1] ?? (m[4] ? "linux" : "any"),
        arch: m[2] ?? "any",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: statSync(join(dir, file)).size,
      },
    ];
  });
if (!assets.some((a) => a.kind === "slim") || !assets.some((a) => a.kind === "standalone")) {
  console.error(`${dir} needs the slim tarball and at least one standalone tarball for ${version}`);
  process.exit(1);
}

writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ version, assets }, null, 2)}\n`);
writeFileSync(join(dir, "checksums.txt"), assets.map((a) => `${a.sha256}  ${a.file}\n`).join(""));
for (const a of assets) console.log(`${a.sha256}  ${a.file}  ${a.bytes}`);
