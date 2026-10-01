import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMEMBER_NUDGE, SESSION_START_PREFIX } from "@ynm/service";
import { testYnmHome, ynm, ynmWith, ynmWithInput } from "../../test/helpers.js";

const hookJson = (o: Record<string, unknown>) => JSON.stringify(o);

/** Every hook run must exit 0 and print exactly one JSON line on stdout. */
function hook(cwd: string, event: string, input: string | undefined) {
  const r = ynmWithInput(cwd, input, "hook", event);
  expect(r.status).toBe(0);
  const lines = r.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return { out: JSON.parse(lines[0] as string) as Record<string, unknown>, stderr: r.stderr };
}

describe("ynm hook", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ynm-hook-"));

  it("session-start returns the context block as additionalContext, prefixed", () => {
    expect(
      ynm(cwd, "remember", "--type", "semantic", "--content", "The user likes to be called Dee")
        .status
    ).toBe(0);
    const { out } = hook(
      cwd,
      "session-start",
      hookJson({
        session_id: "11111111-2222-3333-4444-555555555555",
        cwd,
        hook_event_name: "SessionStart",
        source: "startup",
      })
    );
    const hso = out.hookSpecificOutput as { hookEventName: string; additionalContext: string };
    expect(hso.hookEventName).toBe("SessionStart");
    expect(hso.additionalContext.startsWith(SESSION_START_PREFIX)).toBe(true);
    expect(hso.additionalContext).toContain("called Dee");
  });

  it("prompt nudges on a remember intent and is silent otherwise", () => {
    const yes = hook(
      cwd,
      "prompt",
      hookJson({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "Call me Dee." })
    );
    expect(yes.out).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: REMEMBER_NUDGE },
    });
    const no = hook(
      cwd,
      "prompt",
      hookJson({ prompt: "make parse() always return a list", hook_event_name: "UserPromptSubmit" })
    );
    expect(no.out).toEqual({});
  });

  it("stop expires the session's due working memory, idempotently", async () => {
    const session = "stop-test-session";
    const r = ynm(
      cwd,
      "remember",
      "--type",
      "working",
      "--namespace",
      `session/${session}`,
      "--ttl",
      "PT1S",
      "--content",
      "scratch for this turn",
      "--json"
    );
    expect(r.status).toBe(0);
    await new Promise((res) => setTimeout(res, 1100));
    expect(hook(cwd, "stop", hookJson({ session_id: session, cwd })).out).toEqual({});
    const listed = JSON.parse(
      ynm(cwd, "list", "--type", "working", "--namespace", `session/${session}`, "--json").stdout
    ) as unknown[];
    expect(listed).toHaveLength(0);
    expect(existsSync(join(testYnmHome, "hooks", `stop-${session}`))).toBe(true);
    expect(hook(cwd, "stop", hookJson({ session_id: session, cwd })).out).toEqual({});
  });

  it("tolerates empty, non-JSON and unknown input with {} and exit 0", () => {
    for (const event of ["session-start", "prompt", "stop"]) {
      expect(hook(cwd, event, "").out).toBeTypeOf("object");
      expect(hook(cwd, event, "not json").out).toBeTypeOf("object");
    }
    expect(hook(cwd, "prompt", "").out).toEqual({});
    expect(hook(cwd, "stop", "[1,2]").out).toEqual({});
    const unknown = hook(cwd, "bogus", "{}");
    expect(unknown.out).toEqual({});
    expect(unknown.stderr).toMatch(/unknown event/);
    const missing = ynmWithInput(cwd, "{}", "hook");
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout)).toEqual({});
  });

  it("goes through oclif when the fast path declines, and still answers", () => {
    const viaOclif = ynmWithInput(
      cwd,
      hookJson({ prompt: "Call me Dee." }),
      "hook",
      "--",
      "prompt"
    );
    expect(viaOclif.status).toBe(0);
    expect(JSON.parse(viaOclif.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: REMEMBER_NUDGE },
    });
    const rejected = ynmWithInput(cwd, "{}", "hook", "prompt", "--bogus");
    expect(rejected.status).toBe(0);
    expect(rejected.stdout.trim()).toBe("{}");
    expect(rejected.stderr).toMatch(/^ynm hook: Nonexistent flag: --bogus/);
  });

  it("stop prunes day-old session stamps", () => {
    const dir = join(testYnmHome, "hooks");
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "stop-ancient");
    writeFileSync(old, "");
    const twoDaysAgo = new Date(Date.now() - 48 * 3600_000);
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    expect(hook(cwd, "stop", hookJson({ session_id: "prune-test", cwd })).out).toEqual({});
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(dir, "stop-prune-test"))).toBe(true);
  });

  it("stop still answers when it cannot write a stamp", () => {
    const home = mkdtempSync(join(tmpdir(), "ynm-hook-home-"));
    writeFileSync(join(home, "hooks"), "not a directory");
    const r = ynmWith(
      cwd,
      { input: hookJson({ session_id: "s", cwd }), env: { YNM_HOME: home } },
      "hook",
      "stop"
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
  });

  it("an error opening the store becomes {} with the message on stderr", () => {
    const home = mkdtempSync(join(tmpdir(), "ynm-hook-home-"));
    writeFileSync(join(home, "config.json"), "{bad");
    const r = ynmWith(cwd, { input: "{}", env: { YNM_HOME: home } }, "hook", "session-start");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
    expect(r.stderr).toMatch(/^ynm hook: .*JSON/);
  });
});
