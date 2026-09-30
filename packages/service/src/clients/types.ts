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
  | { kind: "write"; path: string; content: string; reason: string }
  | { kind: "merge-json"; path: string; patch: Record<string, unknown>; reason: string }
  | { kind: "command"; argv: string[]; reason: string }
  /** Nothing to do on disk: a next step the user should take, shown in the plan and report. */
  | { kind: "note"; text: string; reason: string };

export interface Detection {
  installed: boolean;
  detail: string;
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
}

/**
 * One adapter per client (ADR-013). `plan` never touches disk; `apply` performs the changes;
 * `status` feeds `ynm doctor`.
 */
export interface ClientAdapter {
  readonly name: string;
  detect(target: Pick<InstallTarget, "cwd" | "home">): Promise<Detection>;
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
