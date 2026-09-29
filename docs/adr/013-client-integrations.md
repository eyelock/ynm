# ADR-013: Client integration adapters

Status: draft
Satisfies: FR-20, NFR-6, NFR-14

## Context

The old installer script hard-coded three clients. The target set has changed and will keep
changing: Claude Code, GitHub Copilot CLI, OpenCode, Pi, and ynh harnesses. Cursor is dropped.
The clients differ in more than config file paths:

| Client | MCP config | Instructions and skills | Notes |
|---|---|---|---|
| Claude Code | `.mcp.json` (project) or `claude mcp add`; user scope in `~/.claude.json` | `CLAUDE.md`, `.claude/rules/`, skills, hooks | Native MCP, sampling and elicitation support varies by version |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json`; `copilot mcp add --transport http NAME URL` | `AGENTS.md`, `.github/copilot-instructions.md`, `.github/instructions/**` | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli |
| OpenCode | `opencode.json` `mcp` key: `{type: "local", command: [...], environment}` or `{type: "remote", url, headers, oauth}` | `AGENTS.md`, skills | https://opencode.ai/docs/mcp-servers/ |
| Pi | **No native MCP by design.** Extensions are TypeScript modules with tools, commands and events; skills are CLI tools with READMEs | `AGENTS.md`, `SYSTEM.md` under `~/.pi/agent/` and the project | https://pi.dev; integration is an extension or a skill wrapping the ynm CLI |
| ynh | `.ynh-plugin/plugin.json` declares MCP servers, hooks, profiles, focuses and **sensors**; ynh assembles per vendor (Claude, Codex, Copilot, …) | skills, agents, rules, commands inside the harness | `/Users/david/Storage/Workspace/eyelock/ynh`; one declaration reaches every vendor ynh supports |

## Decision (current position)

**One seam, one content source, many adapters.**

```ts
interface ClientAdapter {
  name: string;                                   // "claude-code" | "copilot-cli" | "opencode" | "pi" | "ynh"
  detect(cwd): Promise<Detection>;                // installed? which scope? existing ynm entry?
  plan(target: InstallTarget): Promise<Change[]>; // files to write or commands to run, shown before applying
  apply(changes: Change[]): Promise<void>;
  remove(cwd): Promise<void>;
  status(cwd): Promise<Status>;                   // used by `ynm doctor`
}
// InstallTarget = { transport: "stdio" | "http", url?, auth?, scope: "user" | "project", mounts }
```

`ynm client install <name> [--scope user|project] [--http <url>]` runs `plan`, prints it, and
applies. `ynm client status` reports every detected client. Adapters are discovered from a
registry so a new client is one file plus tests, and third parties can add one.

**Guidance content is authored once**, in `packages/model/src/guidance/` as markdown with
frontmatter (when to remember, when to recall, when to promote to procedural, session start),
and rendered per client: a `CLAUDE.md` include for Claude Code, `AGENTS.md` section for Copilot,
OpenCode and Pi, a skill directory for clients that load skills, and rules or commands for ynh.

**Per-adapter shape:**

- **claude-code**: writes the MCP entry (stdio by default, HTTP when given) at the chosen scope;
  offers the CLAUDE.md include and a `memory` skill; optional `SessionEnd` hook calling
  `ynm session end`.
- **copilot-cli**: writes `~/.copilot/mcp-config.json` (stdio and HTTP); AGENTS.md section.
- **opencode**: writes the `mcp` block in `opencode.json` (`local` or `remote`); AGENTS.md
  section; skill.
- **pi**: no MCP. Ships `@ynm/pi` , a Pi extension exposing `memory_*` tools that call the
  ynm service in-process (same TypeScript, no server), plus a skill README that teaches the
  `ynm` CLI with `--json`. This is the concrete reason ADR-008 requires full CLI parity.
- **ynh**: ships ynm as a ynh harness plugin: `.ynh-plugin/plugin.json` declaring the MCP server
  (stdio and HTTP profiles), the guidance as skills and rules, `on_stop` hook for session end,
  and a `memory-context` **sensor** (`source: {command: "ynm context --format markdown"}`) so
  loop drivers feed pinned memory into every turn. Because ynh assembles per vendor, this adapter
  also covers Codex and any vendor ynh adds later, without ynm knowing about them.

## Alternatives considered

- Keep a shell script per client. Rejected: not testable, not discoverable, no status or removal.
- Only ynh, since it fans out to vendors. Rejected: users without ynh still need direct installs,
  and Pi and OpenCode are not ynh vendors today.

## Consequences

- Every adapter has a fixture-based test: detect on a sample tree, plan, apply to a temp dir,
  compare against golden files.
- `ynm doctor` includes client status.
- Cursor is not an adapter. ynh may still export to Cursor on its own.

## Decided

- The Pi extension is a package in this monorepo (default, 2026-09-28).
- The ynh plugin is a checked-in artefact at the repo root so `ynh install github.com/eyelock/ynm`
  works directly; the adapter only writes client-side config (default, 2026-09-28).

## Open questions

- None outstanding.

## Addenda

Dated notes added while building. Anything here that changes the Decision above is folded into
it at consolidation time.

- 2026-09-29 (M3): `claude-code` and `ynh` adapters ship behind the `ClientAdapter` seam with
  `plan`, `apply` and `status`. Claude Code project scope merges `.mcp.json` and appends a
  delimited block to CLAUDE.md (re-install replaces it); user scope is a `claude mcp add`
  command, never a hand edit of the user's config. The ynh plugin and skill are checked-in
  artefacts generated by `pnpm gen:ynh` from the same source; a test asserts they match, and
  `ynd validate` passes on the repo.
