import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHasGuidance, claudeInstructions } from "./claude-instructions.js";

function repo(files: Record<string, string>): { cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "ynm-ci-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    const p = f.startsWith("~/")
      ? join(home, f.slice(2))
      : f.startsWith("../")
        ? join(root, f.slice(3))
        : join(cwd, f);
    writeFileSync(p, text);
  }
  return { cwd, home };
}

describe("Claude Code instruction lookup", () => {
  it("appends to an existing .claude/CLAUDE.md and never creates a sibling CLAUDE.md", () => {
    const { cwd, home } = repo({ ".claude/CLAUDE.md": "# team\n" });
    expect(claudeInstructions(cwd, home)).toMatchObject({
      mode: "claude-md",
      target: { path: join(cwd, ".claude", "CLAUDE.md"), create: false },
    });
  });
  it("uses AGENTS.md when no CLAUDE file is on the path", () => {
    const { cwd, home } = repo({ "AGENTS.md": "# agents\n" });
    expect(claudeInstructions(cwd, home)).toMatchObject({
      mode: "agents-md",
      target: { path: join(cwd, "AGENTS.md"), create: false },
    });
  });
  it("puts the block in AGENTS.md when CLAUDE.md imports it", () => {
    const { cwd, home } = repo({ "CLAUDE.md": "@AGENTS.md\n", "AGENTS.md": "# shared\n" });
    expect(claudeInstructions(cwd, home).target).toEqual({
      path: join(cwd, "AGENTS.md"),
      create: false,
    });
  });
  it("a CLAUDE.md above the project switches Claude to CLAUDE files; the user file does not", () => {
    const up = repo({ "../CLAUDE.md": "# parent\n", "AGENTS.md": "# agents\n" });
    expect(claudeInstructions(up.cwd, up.home)).toMatchObject({
      mode: "claude-md",
      target: { path: join(up.cwd, "CLAUDE.md"), create: true },
    });
    const user = repo({ "~/.claude/CLAUDE.md": "# me\n", "AGENTS.md": "# agents\n" });
    expect(claudeInstructions(user.cwd, user.home).mode).toBe("agents-md");
  });
  it("creates AGENTS.md only when the project has no instruction file", () => {
    const { cwd, home } = repo({});
    expect(claudeInstructions(cwd, home).target).toEqual({
      path: join(cwd, "AGENTS.md"),
      create: true,
    });
  });
  it("finds the guidance in any file Claude loads, including the user's own", () => {
    const m = "<!-- ynm:guidance -->";
    expect(
      claudeHasGuidance(
        ...(Object.values(repo({ "~/.claude/CLAUDE.md": m })) as [string, string]),
        m
      )
    ).toBe(true);
    const ignored = repo({ ".claude/CLAUDE.md": "# team\n", "AGENTS.md": m });
    expect(claudeHasGuidance(ignored.cwd, ignored.home, m)).toBe(false);
  });
});
