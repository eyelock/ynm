#!/usr/bin/env node
// Extracts the release notes for a version from packages/cli/CHANGELOG.md (written by changesets)
// into dist-release/RELEASE_NOTES.md: the version's section without the dependency-bump lines.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const version = process.argv[2];
if (!version) {
  console.error("usage: notes.mjs <version>");
  process.exit(2);
}
const log = readFileSync(join(root, "packages/cli/CHANGELOG.md"), "utf8");
const start = log.indexOf(`\n## ${version}\n`);
if (start < 0) {
  console.error(`no CHANGELOG section for ${version}; run make version first`);
  process.exit(1);
}
const rest = log.slice(start + `\n## ${version}\n`.length);
const end = rest.search(/\n## /);
const section = (end < 0 ? rest : rest.slice(0, end))
  .split("\n")
  .filter((line, i, all) => !/^- Updated dependencies/.test(line) && !(/^  - @ynm\//.test(line) && /Updated dependencies/.test(all.slice(0, i).reverse().find((l) => /^- /.test(l)) ?? "")))
  .join("\n")
  .replace(/^### (Major|Minor|Patch) Changes\n/m, "")
  .trim();
const notes = `${section}\n\nInstall: see https://eyelock.github.io/ynm/#/how-to/install (Homebrew \`ynm\` standalone or \`ynm-slim\`, direct download, Docker).\n`;
mkdirSync(join(root, "dist-release"), { recursive: true });
writeFileSync(join(root, "dist-release/RELEASE_NOTES.md"), notes);
process.stdout.write(notes);
