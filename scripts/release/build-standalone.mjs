#!/usr/bin/env node
// Builds one standalone ynm binary: Node's single-executable application (SEA) with the
// CommonJS bundle embedded, so the machine needs only git.
//   node scripts/release/build-standalone.mjs --os darwin|linux --arch arm64|amd64 \
//     --node-tarball <node-v<ver>-<os>-<arch>.tar.gz> [--version <ynm version>]
// Output: dist-release/ynm_<version>_<os>_<arch>.tar.gz (ynm, LICENSE, README.md at the root,
// the layout goreleaser gives ynh) and the staged directory beside it.
//
// The SEA blob is platform independent but tied to the Node version that makes it, so it is
// made by the running Node, which must be the tarball's version. Mach-O targets are injected
// and ad-hoc signed on macOS (codesign); ELF targets can be injected from any host.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { inject } from "postject";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const out = join(root, "dist-release");
const { values } = parseArgs({
  options: {
    os: { type: "string" },
    arch: { type: "string" },
    "node-tarball": { type: "string" },
    version: { type: "string" },
  },
});
const { os, arch } = values;
const tarball = values["node-tarball"];
const NODE_ARCH = { arm64: "arm64", amd64: "x64" };
if (!["darwin", "linux"].includes(os ?? "") || !NODE_ARCH[arch ?? ""] || !tarball) {
  console.error(
    "usage: build-standalone.mjs --os darwin|linux --arch arm64|amd64 --node-tarball <file> [--version <v>]"
  );
  process.exit(2);
}
const version =
  values.version ??
  JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;

const nodeDir = basename(tarball).replace(/\.tar\.gz$/, "");
const match = /^node-v(\d+\.\d+\.\d+)-(darwin|linux)-(arm64|x64)$/.exec(nodeDir);
if (!match || match[2] !== os || match[3] !== NODE_ARCH[arch]) {
  console.error(`${basename(tarball)} is not the Node tarball for ${os}/${arch}`);
  process.exit(2);
}
if (`v${match[1]}` !== process.version) {
  console.error(`the SEA blob must be made by Node v${match[1]}; this is ${process.version}`);
  process.exit(2);
}
if (os === "darwin" && process.platform !== "darwin") {
  console.error("darwin binaries are signed with codesign; build them on macOS");
  process.exit(2);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

// 1. The CommonJS bundle (after `pnpm build`) and the blob.
const main = join(out, "ynm.cjs");
run(process.execPath, [join(root, "scripts/release/bundle.mjs"), version]);
const blob = join(out, "sea.blob");
const seaConfig = join(out, "sea-config.json");
writeFileSync(
  seaConfig,
  `${JSON.stringify(
    { main, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false },
    null,
    2
  )}\n`
);
run(process.execPath, ["--experimental-sea-config", seaConfig]);

// 2. The target's node binary, renamed.
const name = `ynm_${version}_${os}_${arch}`;
const stage = join(out, name);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
run("tar", ["-xzf", tarball, "-C", stage, "--strip-components=2", `${nodeDir}/bin/node`]);
const bin = join(stage, "ynm");
copyFileSync(join(stage, "node"), bin);
rmSync(join(stage, "node"));

// 3. Inject. macOS: drop the official signature first, sign ad hoc after.
if (os === "darwin") run("codesign", ["--remove-signature", bin]);
const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
await inject(bin, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: fuse,
  ...(os === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
// A binary of another architecture cannot be run here; the flipped fuse shows the blob went in.
if (!readFileSync(bin).includes(`${fuse}:1`)) {
  console.error(`${bin}: the SEA fuse is not set after injection`);
  process.exit(1);
}
if (os === "darwin") run("codesign", ["--sign", "-", bin]);

// 4. Archive, flat like goreleaser's.
copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));
copyFileSync(join(root, "README.md"), join(stage, "README.md"));
const archive = join(out, `${name}.tar.gz`);
run("tar", ["-czf", archive, "-C", stage, "ynm", "LICENSE", "README.md"]);
console.log(archive);
