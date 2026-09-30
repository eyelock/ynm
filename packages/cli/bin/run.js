#!/usr/bin/env node
import { readFileSync } from "node:fs";

// Client hooks fire every turn: `ynm hook <event>` skips oclif's startup (ADR-016).
let handled = false;
if (process.argv[2] === "hook") {
  const { runHookFast } = await import("../dist/lib/hook.js");
  handled = await runHookFast(process.argv.slice(2));
}
if (!handled) await main();

async function main() {
  const { execute } = await import("@oclif/core");

  // Launched through `make install`'s launcher: report <version>-dev.<sha> so a checkout is
  // distinguishable from a release.
  let loadOptions;
  if (process.env.YNM_DEV_BUILD) {
    const { spawnSync } = await import("node:child_process");
    const root = process.env.YNM_DEV_BUILD;
    const sha =
      spawnSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
      }).stdout?.trim() || "unknown";
    const pjson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    loadOptions = {
      root: new URL("..", import.meta.url).pathname,
      version: `${pjson.version}-dev.${sha}`,
    };
  }

  await execute({ dir: import.meta.url, loadOptions });
}
