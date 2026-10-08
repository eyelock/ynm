import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testYnmHome, ynm } from "../../test/helpers.js";

/** Memory commands in their human (non-JSON) form, outside any git repository. */
describe("ynm memory commands, human output", () => {
  const dir = mkdtempSync(join(tmpdir(), "ynm-memory-"));
  let id = "";

  it("list and recall say so when there is nothing", () => {
    expect(ynm(dir, "list").stdout.trim()).toBe("no memories");
    expect(ynm(dir, "recall", "--text", "anything").stdout.trim()).toBe("no matches");
  });

  it("context and session start say there is no memory yet, not a bare heading", () => {
    const ctx = ynm(dir, "context");
    expect(ctx.status, ctx.stderr).toBe(0);
    expect(ctx.stdout).toBe("no memory yet\n");
    const json = JSON.parse(ynm(dir, "context", "--json").stdout) as { markdown: string };
    expect(json.markdown).toBe("");
    const start = ynm(dir, "session", "start", "s-empty");
    expect(start.status, start.stderr).toBe(0);
    expect(start.stdout).toMatch(
      /^session s-empty\nworking namespace \S+ \(ttl PT8H\)\n\nno memory yet\n$/
    );
    const startJson = JSON.parse(ynm(dir, "session", "start", "s-empty", "--json").stdout) as {
      context: { markdown: string };
    };
    expect(startJson.context.markdown).toBe("");
  });

  it("list, recall --explain and reindex print one line per memory", () => {
    const r = ynm(dir, "remember", "--type", "semantic", "--content", "Indent with tabs", "--json");
    expect(r.status, r.stderr).toBe(0);
    id = (JSON.parse(r.stdout) as { memoryId: string }).memoryId;
    expect(ynm(dir, "pin", id).stdout.trim()).toBe(`pinned ${id}`);
    expect(ynm(dir, "pin", id, "--unpin").stdout.trim()).toBe(`unpinned ${id}`);
    expect(ynm(dir, "pin", id).status).toBe(0);

    const listed = ynm(dir, "list");
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toMatch(
      new RegExp(`^${id}\\s+semantic\\s+personal\\s+\\S+\\s+\\* Indent`)
    );

    const hits = ynm(dir, "recall", "--text", "tabs", "--explain");
    expect(hits.status, hits.stderr).toBe(0);
    expect(hits.stdout).toMatch(
      new RegExp(`^\\d\\.\\d{3}\\s+${id}\\s+semantic\\s+personal\\s+\\* `)
    );
    expect(hits.stdout).toMatch(/\n\s+rel \d\.\d{2} rec \d\.\d{2} imp \d\.\d{2}/);

    expect(ynm(dir, "context", "--budget-tokens", "1").stdout.trim()).toBe(
      "no memory fits the token budget; raise --budget-tokens"
    );

    const plain = ynm(dir, "recall", "--text", "tabs");
    expect(plain.stdout).not.toMatch(/rel \d/);

    const reindexed = ynm(dir, "reindex");
    expect(reindexed.status, reindexed.stderr).toBe(0);
    expect(reindexed.stdout).toMatch(/^personal: 1 memories indexed/);
  });

  it("dream reports each pass, as a dry run or for real", () => {
    const dry = ynm(dir, "dream", "--dry-run");
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/^expire: \d+\/\d+ would change$/m);
    const alone = ynm(dir, "dream", "--judge");
    expect(alone.status).toBe(2);
    expect(alone.stderr).toMatch(/judge only applies to a dry run/);
    const real = ynm(dir, "dream", "--passes", "expire");
    expect(real.status, real.stderr).toBe(0);
    expect(real.stdout.trim()).toMatch(/^expire: \d+\/\d+ changed\nretention: \d+\/\d+ changed$/);
    // A full run finishes with every memory, so the next has nothing new to judge.
    const full = ynm(dir, "dream");
    expect(full.status, full.stderr).toBe(0);
    const again = ynm(dir, "dream");
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout.trim()).toMatch(
      /^expire: \d+\/\d+ changed\nretention: \d+\/\d+ changed\nnothing new since the last run; only expiry ran$/
    );
  });

  it("review lists flagged memories, clears a flag, and needs an id to clear", () => {
    expect(ynm(dir, "review", "list").stdout.trim()).toBe("nothing to review");
    expect(ynm(dir, "annotate", "--memory-id", id, "--needs-review").status).toBe(0);
    const q = ynm(dir, "review", "list");
    expect(q.stdout).toMatch(new RegExp(`^${id}\\s+semantic\\s+personal\\s+Indent with tabs`));
    const json = JSON.parse(ynm(dir, "review", "list", "--mount", "personal", "--json").stdout);
    expect(json).toHaveLength(1);

    const missing = ynm(dir, "review", "clear");
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/memoryId required/);
    const cleared = ynm(dir, "review", "clear", id);
    expect(cleared.status, cleared.stderr).toBe(0);
    expect(cleared.stdout.trim()).toBe(`cleared review flag on ${id}`);
    expect(ynm(dir, "review", "list").stdout.trim()).toBe("nothing to review");
  });

  it("session start prints the context block; end needs an id and expires working memory", () => {
    const start = ynm(dir, "session", "start", "--namespace", "user", "--ttl", "PT1H");
    expect(start.status, start.stderr).toBe(0);
    expect(start.stdout).toMatch(
      /^session \S+\nworking namespace session\/\S+ \(ttl PT1H\)\n\n## Memory/
    );

    const named = JSON.parse(ynm(dir, "session", "start", "s-1", "--json").stdout) as {
      sessionId: string;
    };
    expect(named.sessionId).toBe("s-1");

    const missing = ynm(dir, "session", "end");
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/session end needs a sessionId/);

    const r = ynm(
      dir,
      "remember",
      "--type",
      "working",
      "--namespace",
      "session/s-1",
      "--content",
      "scratch"
    );
    expect(r.status, r.stderr).toBe(0);
    const one = ynm(dir, "session", "end", "s-1");
    expect(one.status, one.stderr).toBe(0);
    expect(one.stdout.trim()).toMatch(/^ended s-1; expired \d+ working memor(y|ies)$/);
    const none = ynm(dir, "session", "end", "s-2", "--no-expire");
    expect(none.stdout.trim()).toBe("ended s-2; expired 0 working memories");
  });

  it("wiki builds pages, ingests an edited page, and needs a file to ingest", () => {
    const out = join(dir, "wiki-out");
    const built = ynm(dir, "wiki", "build", "--mount", "personal", "--dir", out);
    expect(built.status, built.stderr).toBe(0);
    expect(built.stdout).toMatch(/^personal: \d+ pages -> /);

    const pages = join(testYnmHome, "wiki", "personal", "memories");
    const fallback = ynm(dir, "wiki", "build", "--mount", "personal");
    expect(fallback.status, fallback.stderr).toBe(0);
    const page = join(pages, readdirSync(pages).find((f) => f.startsWith(id)) as string);

    const same = ynm(dir, "wiki", "ingest", page);
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout.trim()).toBe(`no change for ${id}`);
    writeFileSync(
      page,
      readFileSync(page, "utf8").replace(/Indent with tabs\s*$/, "Indent with two spaces\n")
    );
    const changed = ynm(dir, "wiki", "ingest", page);
    expect(changed.status, changed.stderr).toBe(0);
    expect(changed.stdout.trim()).toBe(`superseded ${id} from the edited page`);

    const missing = ynm(dir, "wiki", "ingest");
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/file required/);
  });

  it("import reports what it imported and skipped", () => {
    const records = ynm(dir, "export").stdout.split("\n").filter(Boolean);
    const file = join(dir, "records.jsonl");
    writeFileSync(file, `${records[0]}\n`);
    const clean = ynm(dir, "import", file);
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout.trim()).toMatch(/^imported \d+ record\(s\)$/);
    writeFileSync(file, `${records[0]}\nnot json\n`);
    const skipped = ynm(dir, "import", file, "--mount", "personal");
    expect(skipped.stdout.trim()).toMatch(/^imported \d+ record\(s\); skipped 1: /);
  });

  it("purge refuses without --yes, then removes the memory's records", () => {
    const refused = ynm(dir, "purge", id, "--reason", "test");
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/purge is irreversible; re-run with --yes/);
    const purged = ynm(dir, "purge", id, "--reason", "test", "--yes", "--forget-history");
    expect(purged.status, purged.stderr).toBe(0);
    expect(purged.stdout.trim()).toMatch(
      new RegExp(`^purged ${id}: \\d+ record\\(s\\) removed from personal$`)
    );
    expect(ynm(dir, "list").stdout).not.toContain(id);
  });
});

describe("ynm list --namespace", () => {
  const dir = mkdtempSync(join(tmpdir(), "ynm-memory-ns-"));

  it("matches the same memories with or without a trailing slash", () => {
    const r = ynm(
      dir,
      "remember",
      "--type",
      "semantic",
      "--content",
      "slash tolerant",
      "--namespace",
      "factory/github.com/a/b",
      "--json"
    );
    expect(r.status, r.stderr).toBe(0);
    const ids = (args: string[]) => {
      const l = ynm(dir, "list", ...args, "--json");
      expect(l.status, l.stderr).toBe(0);
      return (JSON.parse(l.stdout) as { memoryId: string }[]).map((m) => m.memoryId);
    };
    const plain = ids(["--namespace", "factory"]);
    expect(plain).toHaveLength(1);
    expect(ids(["--namespace", "factory/"])).toEqual(plain);
    expect(ids(["--namespace", "factory//"])).toEqual(plain);
    expect(ids(["--namespace", "/"])).toEqual(ids([]));
  });
});

describe("ynm remember warns about similar memories", () => {
  const dir = mkdtempSync(join(tmpdir(), "ynm-similar-"));

  it("prints a note after the first line on the second near-identical memory, never failing", () => {
    const first = ynm(
      dir,
      "remember",
      "--type",
      "semantic",
      "--content",
      "Notes anchor to the root commit"
    );
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/^remembered \S+ in \S+\n$/);
    const second = ynm(
      dir,
      "remember",
      "--type",
      "semantic",
      "--content",
      "Notes are anchored to the root commit"
    );
    expect(second.status, second.stderr).toBe(0);
    const [line, note] = second.stdout.trim().split("\n");
    expect(line).toMatch(/^remembered \S+ in \S+$/);
    expect(note).toMatch(/^note: 1 similar memory exists: \S+ \(.*\)\. .*`ynm supersede`/);
    // JSON keeps its shape: one "memoryId" line (scripts grep for it) plus a guidance string.
    const raw = ynm(
      dir,
      "remember",
      "--type",
      "semantic",
      "--content",
      "Notes anchor to the root commit again",
      "--json"
    ).stdout;
    expect(raw.match(/"memoryId"/g)).toHaveLength(1);
    expect((JSON.parse(raw) as { guidance: string }).guidance).toMatch(/similar memor/);
  });

  it("dream --dry-run counts candidates without judging", () => {
    const dry = ynm(dir, "dream", "--dry-run");
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/^dedupe: \d+ candidates \(not judged; add --judge\)$/m);
  });
});
