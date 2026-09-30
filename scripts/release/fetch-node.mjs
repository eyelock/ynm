#!/usr/bin/env node
// Downloads the official Node tarball for one target, at the exact version in .nvmrc, and
// verifies it against nodejs.org's SHASUMS256.txt:
//   node scripts/release/fetch-node.mjs --os darwin|linux --arch arm64|amd64
// Prints the tarball's path (dist-release/node/node-v<version>-<os>-<arch>.tar.gz). A tarball
// already there is re-verified, not re-downloaded.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const { values } = parseArgs({ options: { os: { type: "string" }, arch: { type: "string" } } });
const NODE_ARCH = { arm64: "arm64", amd64: "x64" };
if (!["darwin", "linux"].includes(values.os ?? "") || !NODE_ARCH[values.arch ?? ""]) {
  console.error("usage: fetch-node.mjs --os darwin|linux --arch arm64|amd64");
  process.exit(2);
}

const nodeVersion = readFileSync(join(root, ".nvmrc"), "utf8").trim().replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
  console.error(`.nvmrc must pin an exact Node version (found ${nodeVersion})`);
  process.exit(2);
}

const name = `node-v${nodeVersion}-${values.os}-${NODE_ARCH[values.arch]}.tar.gz`;
const base = `https://nodejs.org/dist/v${nodeVersion}`;
const dir = join(root, "dist-release", "node");
const file = join(dir, name);
mkdirSync(dir, { recursive: true });

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

const sums = (await get(`${base}/SHASUMS256.txt`)).toString("utf8");
const expected = sums
  .split("\n")
  .map((l) => l.trim().split(/\s+/))
  .find(([, f]) => f === name)?.[0];
if (!expected) throw new Error(`${name} is not listed in ${base}/SHASUMS256.txt`);

if (!existsSync(file)) writeFileSync(file, await get(`${base}/${name}`));
const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
if (actual !== expected) {
  console.error(`${name}: sha256 ${actual} does not match SHASUMS256.txt (${expected})`);
  process.exit(1);
}
console.log(file);
