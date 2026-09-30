#!/usr/bin/env node
// `make install`: a locally addressable ynm for testing, ynh-style. Writes a launcher at
// $YNM_HOME/bin/ynm (default ~/.ynm/bin/ynm) that runs this checkout's CLI, so a rebuild is picked
// up without reinstalling, and prints the PATH line if that directory is not on PATH.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.YNM_HOME ?? join(homedir(), ".ynm");
const bin = join(home, "bin");
const launcher = join(bin, "ynm");
const remove = process.argv.includes("--remove");

if (remove) {
  if (existsSync(launcher)) rmSync(launcher);
  console.log(`removed ${launcher}`);
  process.exit(0);
}
const runJs = join(root, "packages", "cli", "bin", "run.js");
if (!existsSync(join(root, "packages", "cli", "dist", "commands", "index.js")))
  console.error("warning: packages/cli is not built; run `make build` (make install does this for you)");
mkdirSync(bin, { recursive: true });
writeFileSync(
  launcher,
  `#!/bin/sh\n# ynm dev launcher written by \`make install\` in ${root}\nYNM_DEV_BUILD=${JSON.stringify(root)} exec node ${JSON.stringify(runJs)} "$@"\n`
);
chmodSync(launcher, 0o755);
console.log(`installed ${launcher} -> ${root}`);
const onPath = (process.env.PATH ?? "").split(":").some((p) => resolve(p) === bin);
if (!onPath) {
  const shell = process.env.SHELL ?? "";
  const rc = shell.endsWith("zsh") ? "~/.zshrc" : shell.endsWith("fish") ? "~/.config/fish/config.fish" : "~/.bashrc";
  console.log(`\n${bin} is not on your PATH. Add it (${rc}):\n\n  export PATH="${bin.replace(homedir(), "$HOME")}:$PATH"\n`);
} else console.log(`${bin} is on your PATH; \`ynm --version\` should report a -dev build`);
