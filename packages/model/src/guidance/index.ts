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

let embedded: Partial<Record<GuidanceName, string>> = {};

/**
 * The release bundle has no guidance files beside it: it imports the markdown as text and
 * registers it here before anything asks for it. The checkout reads the files from disk.
 */
export function embedGuidance(texts: Partial<Record<GuidanceName, string>>): void {
  embedded = { ...texts };
}

export function guidance(name: GuidanceName): string {
  const text = embedded[name];
  if (text !== undefined) return text;
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, GUIDANCE[name]), "utf8");
}

export function guidanceNames(): GuidanceName[] {
  return Object.keys(GUIDANCE) as GuidanceName[];
}
