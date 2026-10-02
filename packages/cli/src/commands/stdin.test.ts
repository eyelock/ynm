import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ynm, ynmShell, ynmWithInput } from "../../test/helpers.js";
import { COMMANDS } from "./index.js";

/** A JSONL file with one valid record and one bad line, so a parse is visible in the result. */
function jsonlFixture(dir: string): string {
  expect(
    ynm(dir, "remember", "--type", "semantic", "--content", "piped import fixture").status
  ).toBe(0);
  const exported = ynm(dir, "export");
  expect(exported.status, exported.stderr).toBe(0);
  const first = exported.stdout.split("\n").find(Boolean) as string;
  const file = join(dir, "m.jsonl");
  writeFileSync(file, `${first}\nnot json\n`);
  return file;
}

function expectParsed(r: { stdout: string; stderr: string; status: number | null }): void {
  expect(r.status, r.stderr).toBe(0);
  const { problems } = JSON.parse(r.stdout) as { problems: string[] };
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(/^line 2: invalid JSON/);
}

describe("ynm import reads stdin when no file is given", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ynm-stdin-import-")));
  const file = jsonlFixture(dir);

  it("from a redirect", () => {
    expectParsed(ynmShell(dir, `ynm import --json < "${file}"`));
  });

  it("from a pipe", () => {
    expectParsed(ynmShell(dir, `cat "${file}" | ynm import --json`));
  });

  it("from a slow producer", () => {
    expectParsed(ynmShell(dir, `(sleep 1; cat "${file}") | ynm import --json`));
  });

  it("still reads a named file, ignoring stdin", () => {
    expectParsed(ynmWithInput(dir, "not a file name", "import", file, "--json"));
  });
});

describe("piped stdin never fills a positional argument", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ynm-stdin-args-")));

  it("validate checks the current directory, not one named by stdin", () => {
    const r = ynmWithInput(dir, "hello", "validate");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nothing to validate in");
    expect(r.stderr).not.toContain("hello");
  });

  it("session start does not take its session id from stdin", () => {
    const r = ynmWithInput(dir, "from-stdin", "session", "start", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("from-stdin");
  });

  it("review clear still asks for a memory id", () => {
    const r = ynmWithInput(dir, "01JZZZZZZZZZZZZZZZZZZZZZZZ", "review", "clear");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("memoryId required");
  });

  it("wiki ingest still asks for a file", () => {
    const r = ynmWithInput(dir, "page.md", "wiki", "ingest");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("file required");
  });

  it("client status does not read a client name from stdin", () => {
    const r = ynmWithInput(dir, "not-a-client", "client", "status");
    expect(r.stderr).not.toContain("not-a-client");
  });

  it("a required argument is not read from stdin either", () => {
    const r = ynmWithInput(dir, "list", "review");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Missing 1 required arg/);
  });

  it("every command's arguments ignore stdin", () => {
    for (const [id, cmd] of Object.entries(COMMANDS)) {
      const args = (cmd as { args?: Record<string, { ignoreStdin?: boolean }> }).args ?? {};
      for (const [name, arg] of Object.entries(args))
        expect(arg.ignoreStdin, `${id} ${name}`).toBe(true);
    }
  });
});
