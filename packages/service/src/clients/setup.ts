import { spawn } from "node:child_process";
import type { ClientSetup } from "./index.js";

/** Runs a client's own command in `cwd`, its output kept off init's report; rejects on a non-zero exit. */
export function runInProject(argv: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd as string, args, { cwd, stdio: "ignore" });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${argv.join(" ")} exited ${code}`))
    );
    child.on("error", reject);
  });
}

/** The report lines for one client init configured: what was applied, what is left to run, what was left alone. */
export function clientSetupLines(c: ClientSetup): string[] {
  return [
    `  client    ${c.client}: ${c.applied.length ? c.applied.join(", ") : "unchanged"}`,
    ...c.run.map((r) => `  run:      ${r}`),
    ...c.left.map(
      (f) =>
        `  left      ${f} is tracked by git, so init did not edit it (add ynm's setup by hand if the team wants it)`
    ),
  ];
}
