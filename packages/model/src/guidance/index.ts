import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Guidance authored once and rendered per client (ADR-013) and as MCP prompts (ADR-008). */
export const GUIDANCE = {
  "session-start": "session-start.md",
  "when-to-remember": "when-to-remember.md",
  "when-to-promote": "when-to-promote.md",
} as const;
export type GuidanceName = keyof typeof GUIDANCE;

const here = dirname(fileURLToPath(import.meta.url));

export function guidance(name: GuidanceName): string {
  return readFileSync(join(here, GUIDANCE[name]), "utf8");
}

export function guidanceNames(): GuidanceName[] {
  return Object.keys(GUIDANCE) as GuidanceName[];
}
