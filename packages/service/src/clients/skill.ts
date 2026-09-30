import { guidance } from "@ynm/model";
import { TOOL_SPECS, type ToolSpec } from "../tools.js";

/** Where the skill lives in ynm's repository, for includes (`integrations/skills/ynm-memory`). */
export const SKILLS_PATH = "integrations";

/**
 * The one `ynm-memory` skill, in the Agent Skills format (name and description frontmatter,
 * markdown body), so any harness or client that loads skills can use it: ynh by include, Pi by
 * `ynm client install pi`, Claude Code, Codex, Copilot CLI or OpenCode from a skills directory.
 */
export function ynmSkill(): string {
  return `---
name: ynm-memory
description: Use persistent memory (ynm) deliberately - recall before answering, remember decisions and preferences, supersede rather than duplicate. The memory_* tools come from ynm's MCP server (in Pi, from its extension); every one is also \`ynm <command> --json\`.
---

${guidance("session-start").trim()}

${guidance("when-to-remember").trim()}

${guidance("when-to-promote").trim()}

## CLI parity

Every tool is also a command with the same flags: ${(TOOL_SPECS as readonly ToolSpec[]).map((t) => `\`ynm ${t.command}\``).join(", ")}. Add \`--json\` for machine-readable output.
`;
}
