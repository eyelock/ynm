import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The release version, from the CLI package; baselines and reports are keyed by it. */
export const YNM_VERSION: string = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "cli", "package.json"), "utf8")
  ) as { version: string }
).version;
