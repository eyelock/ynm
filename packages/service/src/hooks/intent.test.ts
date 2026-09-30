import {
  isRememberIntent,
  parseHookInput,
  promptHook,
  REMEMBER_INTENT_PHRASES,
  REMEMBER_NUDGE,
} from "./intent.js";

describe("remember intent (ADR-016)", () => {
  it.each([
    "Remember that I prefer tabs",
    "remember: the staging db is read-only",
    "Please remember my name is Dee",
    "please, remember the port is 5433",
    "Don't forget to use pnpm here",
    "don’t forget the changeset",
    "Do not forget the release notes",
    "From now on, write tests first",
    "Always run make verify before committing",
    "Fix the bug. Never use var in this codebase.",
    "Call me Dee.",
    "My preference is short commit messages",
    "Note that the API is rate limited",
    "Thanks!\nAlso remember the docs",
    "ok, from now on use British spelling",
    "Refactor this - always prefer composition",
  ])("fires on %j", (prompt) => {
    expect(isRememberIntent(prompt)).toBe(true);
  });

  it.each([
    "make parse() always return a list",
    "why does this function never terminate?",
    "What do you remember about the build?",
    "the loop should always exit on EOF",
    "add a remembered flag to the cache",
    "rename neverMind to ignore",
    "this test is always failing on CI",
    "can you call me back function with retries",
    "",
  ])("stays quiet on %j", (prompt) => {
    expect(isRememberIntent(prompt)).toBe(false);
  });

  it("covers every phrase in the exported list", () => {
    for (const p of REMEMBER_INTENT_PHRASES) expect(isRememberIntent(`${p} this`), p).toBe(true);
  });
});

describe("hook input and output", () => {
  it("parses empty, garbage and non-object stdin as {}", () => {
    expect(parseHookInput("")).toEqual({});
    expect(parseHookInput("   ")).toEqual({});
    expect(parseHookInput("not json")).toEqual({});
    expect(parseHookInput("[1]")).toEqual({});
    expect(parseHookInput("null")).toEqual({});
    expect(parseHookInput('{"prompt":"x"}')).toEqual({ prompt: "x" });
  });

  it("the prompt hook answers in Claude Code's UserPromptSubmit shape", () => {
    expect(promptHook({ prompt: "Remember I use zsh" })).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: REMEMBER_NUDGE },
    });
    expect(promptHook({ prompt: "list files" })).toEqual({});
    expect(promptHook({})).toEqual({});
  });
});
