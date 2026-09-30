/**
 * Agent hooks (ADR-016), the part that needs no store: event names, stdin parsing, the reply
 * shape and the remember-intent test. It imports nothing, so `ynm hook prompt` starts fast; it is
 * exported on its own as `@ynm/service/hook-intent`.
 *
 * The shapes follow Claude Code's hook contract, which Codex shares: stdin carries `session_id`,
 * `cwd`, `hook_event_name` and per event `prompt` or `source`; stdout is
 * `{hookSpecificOutput: {hookEventName, additionalContext}}` or `{}`. A hook never blocks.
 */
export const HOOK_EVENTS = ["session-start", "prompt", "stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The client's event name for each hook, as `hookSpecificOutput.hookEventName` expects it. */
export const HOOK_CLIENT_EVENTS: Record<HookEvent, string> = {
  "session-start": "SessionStart",
  prompt: "UserPromptSubmit",
  stop: "Stop",
};

/** The fields ynm reads from a hook's stdin; everything else the client sends is ignored. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  source?: string;
}

export type HookOutput =
  | Record<string, never>
  | { hookSpecificOutput: { hookEventName: string; additionalContext: string } };

export const SESSION_START_PREFIX =
  "ynm memory for this session (use memory_recall for more; use memory_remember to keep facts, not note files):";

export const REMEMBER_NUDGE =
  "The user is asking you to remember something. Store it with memory_remember (ynm), not in a note file or memory directory. Prefer memory_supersede if a memory on this already exists.";

/**
 * Phrases that mean "keep this". Each must open a clause (the start of the prompt, or after
 * `.`, `!`, `?`, `;`, `:`, a newline or a dash, optionally after a filler such as "and" or "ok")
 * or follow "please", so "always" inside a sentence about code does not fire. A false positive
 * costs the model one sentence; a miss costs the memory.
 */
export const REMEMBER_INTENT_PHRASES = [
  "remember",
  "don't forget",
  "do not forget",
  "from now on",
  "always",
  "never",
  "call me",
  "my preference",
  "note that",
] as const;

const phrases = REMEMBER_INTENT_PHRASES.map((p) =>
  p.replace(/'/g, "['’]").replace(/ /g, "\\s+")
).join("|");

/** One regex built from the phrase list: a clause start (or "please"), then a phrase as a word. */
export const REMEMBER_INTENT_PATTERN = new RegExp(
  `(?:^|[.!?;:\\n]|\\s[-–—]|\\bplease,?)\\s*(?:(?:and|also|but|so|oh|ok|okay|hey|btw)[,\\s]+)?(?:${phrases})\\b`,
  "i"
);

export function isRememberIntent(prompt: string): boolean {
  return REMEMBER_INTENT_PATTERN.test(prompt);
}

/** Parses hook stdin; empty or non-JSON input is an empty object, never an error. */
export function parseHookInput(raw: string): HookInput {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as HookInput) : {};
  } catch {
    return {};
  }
}

export function hookContext(event: HookEvent, text: string): HookOutput {
  return {
    hookSpecificOutput: { hookEventName: HOOK_CLIENT_EVENTS[event], additionalContext: text },
  };
}

/** The prompt hook answers from the prompt text alone. */
export function promptHook(input: HookInput): HookOutput {
  return typeof input.prompt === "string" && isRememberIntent(input.prompt)
    ? hookContext("prompt", REMEMBER_NUDGE)
    : {};
}
