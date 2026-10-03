#!/usr/bin/env node
// `make install`: a locally addressable ynm for testing, ynh-style. Writes a launcher at
// $YNM_HOME/bin/ynm (default ~/.ynm/bin/ynm) that runs this checkout's CLI, so a rebuild is picked
// up without reinstalling, and prints the PATH line if that directory is not on PATH.
import { execFileSync } from "node:child_process";
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
// The main checkout of this repository, or null when `root` is the main checkout (or not in git).
function mainCheckout() {
  try {
    const git = (arg) =>
      resolve(root, execFileSync("git", ["rev-parse", arg], { cwd: root, encoding: "utf8" }).trim());
    const common = git("--git-common-dir");
    return git("--git-dir") === common ? null : dirname(common);
  } catch {
    return null;
  }
}
const main = mainCheckout();
if (main)
  console.error(
    `warning: ${root} is a git worktree; the launcher stops working when it is removed.\n` +
      `         Run \`make install\` from ${main} for a launcher that outlives the worktree.`
  );
const reinstallFrom = main ?? root;
// The launcher checks that the checkout still exists. Under `ynm hook` it prints `{}` and exits 0
// so a broken dev install never fails an agent session; otherwise it exits 1 with the fix.
// Single-quoted for sh: nothing inside is expanded (a backtick in the message would run a command).
const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const gone = `ynm dev build at ${root} is gone; re-run \`make install\` from ${reinstallFrom}`;
mkdirSync(bin, { recursive: true });
writeFileSync(
  launcher,
  [
    "#!/bin/sh",
    `# ynm dev launcher written by \`make install\` in ${root}`,
    `if [ ! -f ${q(runJs)} ]; then`,
    `  echo ${q(gone)} >&2`,
    `  if [ "$1" = hook ]; then echo '{}'; exit 0; fi`,
    "  exit 1",
    "fi",
    `YNM_DEV_BUILD=${q(root)} exec node ${q(runJs)} "$@"`,
    "",
  ].join("\n")
);
chmodSync(launcher, 0o755);
console.log(`installed ${launcher} -> ${root}`);
const onPath = (process.env.PATH ?? "").split(":").some((p) => resolve(p) === bin);
if (!onPath) {
  const shell = process.env.SHELL ?? "";
  const rc = shell.endsWith("zsh") ? "~/.zshrc" : shell.endsWith("fish") ? "~/.config/fish/config.fish" : "~/.bashrc";
  console.log(`\n${bin} is not on your PATH. Add it (${rc}):\n\n  export PATH="${bin.replace(homedir(), "$HOME")}:$PATH"\n`);
} else console.log(`${bin} is on your PATH; \`ynm --version\` should report a -dev build`);
