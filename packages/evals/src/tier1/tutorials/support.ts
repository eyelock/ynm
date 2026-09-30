import { chmodSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Shared by the tutorial smoke test (tier 1) and the model-driven reader (tier 2). */
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");
export const tutorials = join(repoRoot, "docs", "tutorial");
const cli = join(repoRoot, "packages", "cli", "bin", "run.js");

export interface TutorialBlock {
  heading: string;
  code: string;
  /** From an HTML comment on the line before the fence: `<!-- tutorial: skip unless X -->`. */
  skipUnlessEnv?: string;
}

/** Extracts the bash blocks of a tutorial with the nearest heading and any skip marker. */
export function tutorialBlocks(markdown: string): TutorialBlock[] {
  const out: TutorialBlock[] = [];
  let heading = "";
  let pending: string | undefined;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const h = /^#{1,3}\s+(.*)$/.exec(line);
    if (h) heading = h[1] as string;
    const skip = /^<!--\s*tutorial:\s*skip unless\s+([A-Z0-9_]+)\s*-->$/.exec(line.trim());
    if (skip) {
      pending = skip[1];
      continue;
    }
    if (line.trim() === "```bash") {
      const code: string[] = [];
      for (i += 1; i < lines.length && (lines[i] as string).trim() !== "```"; i++)
        code.push(lines[i] as string);
      out.push({ heading, code: code.join("\n"), skipUnlessEnv: pending });
      pending = undefined;
    } else if (line.trim() !== "") pending = undefined;
  }
  return out;
}

export function tutorialFiles(): string[] {
  return readdirSync(tutorials)
    .filter((f) => /^\d{2}-.*\.md$/.test(f))
    .sort();
}

/** A PATH entry with `ynm` pointing at this checkout, as the tutorial index tells humans to make. */
export function sandboxBin(): string {
  const bin = mkdtempSync(join(tmpdir(), "ynm-tutorial-bin-"));
  writeFileSync(join(bin, "ynm"), `#!/bin/sh\nexec node ${cli} "$@"\n`);
  chmodSync(join(bin, "ynm"), 0o755);
  return bin;
}

/** The literal sandbox path every tutorial uses; humans keep it, runners swap it per run. */
export const TUTORIAL_SANDBOX = "/tmp/ynm-tutorial";

/** A private sandbox root for one run, so concurrent runs (CI, agents, a human) never collide. */
export function privateSandbox(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "ynm-tutorial-run-")));
}

/** Rewrites the literal sandbox path in tutorial text or code to a private root. */
export function withSandbox(text: string, root: string): string {
  return text.split(TUTORIAL_SANDBOX).join(root);
}

/** Environment for a tutorial run: PATH with `ynm`, and the home pinned inside the sandbox. */
export function sandboxEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandboxBin()}:${process.env.PATH ?? ""}`,
    YNM_NO_CLAUDE_CLI: "1",
    YNM_HOME: join(root, "home"),
    YNM_USER: "tutorial",
  };
}
