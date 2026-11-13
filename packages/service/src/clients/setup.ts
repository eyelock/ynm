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

/**
 * The report lines for one client init configured: what was applied, what is left to run, what was
 * left alone. `reported` holds the left-alone files an earlier client already named, so a file two
 * clients share (opencode and pi both read AGENTS.md) is reported once.
 */
export function clientSetupLines(c: ClientSetup, reported: Set<string> = new Set()): string[] {
  const left = c.left.filter((f) => !reported.has(f));
  for (const f of left) reported.add(f);
  return [
    `  client    ${c.client}: ${c.applied.length ? c.applied.join(", ") : "unchanged"}`,
    ...c.run.map((r) => `  run:      ${r}`),
    ...left.map(
      (f) =>
        `  left      ${f} is tracked by git, so init did not edit it (add ynm's setup by hand if the team wants it)`
    ),
  ];
}

/** The lines for every client init configured, each left-alone file named once. */
export function clientsSetupLines(clients: ClientSetup[]): string[] {
  const reported = new Set<string>();
  return clients.flatMap((c) => clientSetupLines(c, reported));
}
