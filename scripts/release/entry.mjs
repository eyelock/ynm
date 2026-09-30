// Entry point of the release bundle (scripts/release/bundle.mjs), never run unbundled.
// oclif normally reads package.json from disk and imports the explicit command map by path;
// the bundle has neither, so this builds the root plugin from an in-memory package.json and
// hands it the command map directly. No top-level await: the same file becomes the CommonJS
// main script of the single-executable binary.
import { dirname } from "node:path";
import { Config, execute, Plugin } from "@oclif/core";
import { COMMANDS } from "../../packages/cli/dist/commands/index.js";
import { runHookFast } from "../../packages/cli/dist/lib/hook.js";
import { embedGuidance } from "../../packages/model/dist/guidance/index.js";
import sessionStart from "../../packages/model/src/guidance/session-start.md";
import whenToPromote from "../../packages/model/src/guidance/when-to-promote.md";
import whenToRemember from "../../packages/model/src/guidance/when-to-remember.md";

embedGuidance({
  "session-start": sessionStart,
  "when-to-remember": whenToRemember,
  "when-to-promote": whenToPromote,
});

// Replaced at build time with the CLI's package.json, trimmed to what oclif reads.
const pjson = YNM_PJSON;

async function main() {
  // Client hooks fire every turn: `ynm hook <event>` skips oclif's startup (ADR-016).
  if (process.argv[2] === "hook" && (await runHookFast(process.argv.slice(2)))) return;
  const root = dirname(process.execPath);
  const plugin = new Plugin({ isRoot: true, pjson, root, ignoreManifest: true });
  // oclif's explicit strategy imports `oclif.commands.target` from disk on first use and caches
  // the result here. Seeding the cache is the only way to supply the map in memory.
  plugin.commandCache = COMMANDS;
  await plugin.load();
  const config = await Config.load({ root, pjson, plugins: new Map([[pjson.name, plugin]]) });
  await execute({ loadOptions: config });
}

main();
