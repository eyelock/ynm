#!/usr/bin/env node
// Line coverage of the lines a change adds or modifies. Reads each package's
// coverage/lcov.info (written by `make coverage`) and the diff against a base ref, and fails
// when the covered share of changed, instrumented lines is below the minimum. Lines coverage
// cannot see (comments, types, files excluded from coverage) are not counted.
//
//   node scripts/coverage-diff.mjs [--base origin/develop] [--min 80]
//
// The diff runs from the merge base to the working tree, so uncommitted changes count locally.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "origin/develop" },
    min: { type: "string", default: "80" },
  },
});
const min = Number(values.min);
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

/** Repo-relative path → set of line numbers added or modified since the merge base. */
function changedLines(base) {
  const mergeBase = git("merge-base", base, "HEAD").trim();
  const diff = git("diff", "--unified=0", "--no-color", "--no-renames", mergeBase, "--", "packages");
  const changed = new Map();
  let file;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? undefined : line.slice("+++ b/".length);
      if (file && !changed.has(file)) changed.set(file, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n++) changed.get(file).add(n);
    }
  }
  return changed;
}

/** Repo-relative path → map of instrumented line → hit count, across every package's lcov. */
function lineHits() {
  const hits = new Map();
  const packages = join(root, "packages");
  for (const pkg of readdirSync(packages)) {
    const lcov = join(packages, pkg, "coverage", "lcov.info");
    if (!existsSync(lcov)) continue;
    let lines;
    for (const line of readFileSync(lcov, "utf8").split("\n")) {
      if (line.startsWith("SF:")) {
        const sf = line.slice(3);
        const file = relative(root, isAbsolute(sf) ? sf : resolve(packages, pkg, sf));
        lines = hits.get(file) ?? new Map();
        hits.set(file, lines);
      } else if (line.startsWith("DA:") && lines) {
        const [n, count] = line.slice(3).split(",").map(Number);
        lines.set(n, Math.max(lines.get(n) ?? 0, count));
      }
    }
  }
  return hits;
}

const changed = changedLines(values.base);
const hits = lineHits();
if (hits.size === 0) {
  console.error("coverage-diff: no packages/*/coverage/lcov.info found; run `make coverage` first.");
  process.exit(1);
}

let total = 0;
let covered = 0;
const rows = [];
for (const [file, lines] of [...changed].sort(([a], [b]) => a.localeCompare(b))) {
  const fileHits = hits.get(file);
  if (!fileHits) continue;
  const measured = [...lines].filter((n) => fileHits.has(n));
  if (measured.length === 0) continue;
  const missed = measured.filter((n) => fileHits.get(n) === 0);
  total += measured.length;
  covered += measured.length - missed.length;
  rows.push({ file, measured: measured.length, missed });
}

if (total === 0) {
  console.log(`coverage-diff: no instrumented lines changed since ${values.base}.`);
  process.exit(0);
}

for (const { file, measured, missed } of rows) {
  const pct = ((100 * (measured - missed.length)) / measured).toFixed(1);
  const uncovered = missed.length ? `  uncovered: ${ranges(missed)}` : "";
  console.log(`${pct.padStart(6)}%  ${file} (${measured} lines)${uncovered}`);
}
const pct = (100 * covered) / total;
console.log(`\ncoverage-diff: ${covered}/${total} changed lines covered (${pct.toFixed(1)}%), minimum ${min}%.`);
process.exit(pct + 1e-9 >= min ? 0 : 1);

/** [3,4,5,9] → "3-5, 9" */
function ranges(ns) {
  const out = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    out.push(i === j ? `${ns[i]}` : `${ns[i]}-${ns[j]}`);
    i = j;
  }
  return out.join(", ");
}
