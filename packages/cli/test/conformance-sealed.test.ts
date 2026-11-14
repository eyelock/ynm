import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { bin } from "./helpers.js";

/**
 * `.ynr/conformance.yaml` promises scenarios with no model, no secret and no network (ynm #158).
 * ynm loads a repository's `.env` (the main checkout's, from a worktree) and reads model keys from
 * the environment, so each scenario has to leave the repository and clear the keys itself. This
 * runs every scenario from a git repository whose `.env` and shell both hold a key, with a `ynm`
 * that records what it was started with before running the real CLI.
 */
const file = fileURLToPath(new URL("../../../.ynr/conformance.yaml", import.meta.url));
const scenarios = (
  parse(readFileSync(file, "utf8")) as { scenarios: { name: string; run: string }[] }
).scenarios;

describe("conformance scenarios are sealed from local secrets (ynm #158)", () => {
  const root = mkdtempSync(join(tmpdir(), "ynm-sealed-"));
  const repo = join(root, "repo");
  const shim = join(root, "bin");
  const record = join(root, "record");

  beforeAll(() => {
    mkdirSync(repo);
    mkdirSync(shim);
    spawnSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, ".env"), "TYPESAFE_API_KEY=planted-in-dotenv\n");
    writeFileSync(
      join(shim, "ynm"),
      `#!/bin/sh
{ echo "key=\${TYPESAFE_API_KEY-unset} openai=\${OPENAI_API_KEY-unset}"; git rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo repo || echo norepo; } >> "${record}"
exec "${process.execPath}" "${bin}" "$@"
`
    );
    chmodSync(join(shim, "ynm"), 0o755);
  });

  it.each(scenarios.map((s) => [s.name, s.run]))(
    "%s runs outside any repository, with no model key",
    (_name, run) => {
      writeFileSync(record, "");
      const r = spawnSync("sh", ["-c", run], {
        cwd: repo,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${shim}:${process.env.PATH}`,
          TYPESAFE_API_KEY: "planted-in-shell",
          OPENAI_API_KEY: "planted-in-shell",
        },
      });
      expect(r.status, r.stderr).toBe(0);
      const seen = readFileSync(record, "utf8").trim().split("\n");
      expect(seen).toEqual(["key=unset openai=unset", "norepo"]);
    }
  );
});
