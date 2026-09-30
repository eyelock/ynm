import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export type Transport =
  | { kind: "stdio"; command: string; args: string[] }
  | { kind: "http"; url: string; bearer?: string };

export interface InstallTarget {
  cwd: string;
  home: string;
  scope: "user" | "project";
  transport: Transport;
  /** Install the client's agent hooks where it has them (ADR-016); default true. */
  hooks?: boolean;
}

export type Change =
  /** `label` names the change in `ynm init`'s one-line summary; default the relative path. */
  | { kind: "write"; path: string; content: string; reason: string; label?: string }
  | {
      kind: "merge-json";
      path: string;
      patch: Record<string, unknown>;
      reason: string;
      label?: string;
    }
  | { kind: "command"; argv: string[]; reason: string }
  /** Nothing to do on disk: a next step the user should take, shown in the plan and report. */
  | { kind: "note"; text: string; reason: string };

export interface Detection {
  installed: boolean;
  detail: string;
  /** Which of the three signals fired (ADR-016); any one is enough. */
  signals?: { path: boolean; user: boolean; project: boolean };
}

/** Where detection looks: the project, the user's home, and PATH from `env` (default process.env). */
export type DetectTarget = Pick<InstallTarget, "cwd" | "home"> & { env?: NodeJS.ProcessEnv };

/** True when an executable file named `bin` is in a PATH directory; scans, never spawns. */
export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      const p = join(dir, bin);
      if (statSync(p).isFile()) {
        accessSync(p, constants.X_OK);
        return true;
      }
    } catch {
      // not here
    }
  }
  return false;
}

export interface ClientSignals {
  /** The client's executable. */
  bin: string;
  /** User-level footprint, relative to home. */
  user: string[];
  /** Project-level footprint, relative to the project. */
  project: string[];
}

/**
 * Detects a client from three signals (ADR-016): its executable on PATH, its user-level
 * footprint, its project-level footprint. The detail names every signal that fired.
 */
export function detectBySignals(s: ClientSignals, t: DetectTarget): Detection {
  const path = onPath(s.bin, t.env);
  const user = s.user.find((p) => existsSync(join(t.home, p)));
  const project = s.project.find((p) => existsSync(join(t.cwd, p)));
  const fired = [
    ...(path ? [`${s.bin} on PATH`] : []),
    ...(user ? [`~/${user}`] : []),
    ...(project ? [project] : []),
  ];
  return {
    installed: fired.length > 0,
    detail: fired.length ? fired.join(", ") : "not detected",
    signals: { path, user: !!user, project: !!project },
  };
}

export interface ClientStatus {
  client: string;
  /** The ynm server is registered with the client. */
  configured: boolean;
  detail: string;
  /** The memory guidance reaches the agent (instruction block or skill); absent when unknown. */
  guidance?: boolean;
  /** ynm's agent hooks are installed; absent when the client has no hooks ynm installs. */
  hooks?: boolean;
  /** What was checked and where each piece was found, one human line each. */
  checked?: string[];
  /** Files ynm's setup for this client was found in, any scope; init keeps those in the project. */
  files?: string[];
}

/**
 * One adapter per client (ADR-013). `plan` never touches disk; `apply` performs the changes;
 * `status` feeds `ynm doctor`.
 */
export interface ClientAdapter {
  readonly name: string;
  detect(target: DetectTarget): Promise<Detection>;
  plan(target: InstallTarget): Promise<Change[]>;
  status(target: Pick<InstallTarget, "cwd" | "home">): Promise<ClientStatus>;
}

export function stdioServerEntry(t: Transport): Record<string, unknown> {
  return t.kind === "stdio"
    ? { command: t.command, args: t.args }
    : {
        type: "http",
        url: t.url,
        ...(t.bearer ? { headers: { Authorization: `Bearer ${t.bearer}` } } : {}),
      };
}
