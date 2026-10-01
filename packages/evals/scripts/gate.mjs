#!/usr/bin/env node
// Runs one milestone gate: `make gate M=M1`. A gate is closed only when it is green with zero todos.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const milestone = (process.argv[2] ?? "").toUpperCase();
if (!/^M[0-6]$/.test(milestone)) {
  console.error("usage: make gate M=M<0-6>");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "..", "src", "gates", `${milestone.toLowerCase()}.gate.test.ts`);
if (!existsSync(file)) {
  console.error(`no gate file for ${milestone}: ${file}`);
  process.exit(2);
}
const result = spawnSync("pnpm", ["exec", "vitest", "run", "--reporter=verbose", file], {
  cwd: join(here, ".."),
  stdio: "inherit",
  env: { ...process.env, YNM_GATE: milestone },
});
process.exit(result.status ?? 1);
