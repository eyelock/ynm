import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AuditEvent,
  Auditor,
  type AuditSink,
  auditSinkFromEnv,
  fileSink,
  jsonBytes,
  recordCall,
  runAudited,
  stdoutSink,
} from "./audit.js";

function memorySink(): AuditSink & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { events, write: async (e) => void events.push(e) };
}

/** A clock that advances 5 ms on every read. */
function clock(start = Date.parse("2026-10-01T09:14:03.120Z")): () => Date {
  let t = start;
  return () => {
    const d = new Date(t);
    t += 5;
    return d;
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("Auditor", () => {
  it("writes an ok event with identity, path only and calls", async () => {
    const sink = memorySink();
    const auditor = new Auditor(sink, { now: clock() });
    const res = await auditor.around({ method: "POST", url: "/mcp?secret=x" }, async () => {
      recordCall({ tool: "memory_recall", status: "ok", inputBytes: 12, resultCount: 2 });
      return { status: 200, person: "pabcdefghijklmnop", client: "claude-code", extra: 1 };
    });
    expect(res.extra).toBe(1);
    expect(sink.events).toHaveLength(1);
    const e = sink.events[0] as AuditEvent;
    expect(e).toMatchObject({
      at: "2026-10-01T09:14:03.120Z",
      person: "pabcdefghijklmnop",
      client: "claude-code",
      method: "POST",
      path: "/mcp",
      status: 200,
      outcome: "ok",
      calls: [{ tool: "memory_recall", status: "ok", inputBytes: 12, resultCount: 2 }],
      durationMs: 5,
    });
    expect(e.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(e).not.toHaveProperty("reason");
  });

  it("records a refusal with its reason and no identity", async () => {
    const sink = memorySink();
    await new Auditor(sink).around({ method: "GET", url: "http://h/mcp" }, async () => ({
      status: 401,
      reason: "invalid_token",
    }));
    expect(sink.events[0]).toMatchObject({
      status: 401,
      outcome: "refused",
      reason: "invalid_token",
    });
    expect(sink.events[0]).not.toHaveProperty("person");
    expect(sink.events[0]).not.toHaveProperty("client");
  });

  it("treats 403 as refused and other 4xx/5xx as errors, without a reason", async () => {
    const sink = memorySink();
    const auditor = new Auditor(sink);
    for (const status of [403, 400, 503])
      await auditor.around({ method: "POST", url: "/mcp" }, async () => ({ status, reason: "r" }));
    expect(sink.events.map((e) => [e.outcome, e.reason])).toEqual([
      ["refused", "r"],
      ["error", undefined],
      ["error", undefined],
    ]);
  });

  it("writes a 500 event with the calls so far when the handler throws, then rethrows", async () => {
    const sink = memorySink();
    const auditor = new Auditor(sink);
    await expect(
      auditor.around({ method: "POST", url: "/mcp" }, async () => {
        recordCall({ tool: "memory_write", status: "error" });
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      status: 500,
      outcome: "error",
      calls: [{ tool: "memory_write", status: "error" }],
    });
  });

  it("collects calls from nested async work and keeps concurrent requests apart", async () => {
    const sink = memorySink();
    const auditor = new Auditor(sink);
    const deep = async (tool: string) => {
      await tick();
      await Promise.all(
        [1, 2].map(async (n) => {
          await tick();
          recordCall({ tool: `${tool}.${n}`, status: "ok" });
        })
      );
      setTimeout(() => recordCall({ tool: "late", status: "ok" }), 0);
    };
    await Promise.all([
      auditor.around({ method: "POST", url: "/a" }, async () => {
        await deep("a");
        return { status: 200 };
      }),
      auditor.around({ method: "POST", url: "/b" }, async () => {
        await deep("b");
        return { status: 200 };
      }),
    ]);
    const byPath = Object.fromEntries(
      sink.events.map((e) => [e.path, e.calls.map((c) => c.tool).sort()])
    );
    expect(byPath).toEqual({ "/a": ["a.1", "a.2"], "/b": ["b.1", "b.2"] });
  });

  it("does not fail the request when the sink fails, and reports the failure", async () => {
    const errors: unknown[] = [];
    const auditor = new Auditor(
      { write: async () => Promise.reject(new Error("disk full")) },
      { onError: (e) => errors.push(e) }
    );
    const res = await auditor.around({ method: "POST", url: "/mcp" }, async () => ({
      status: 200,
    }));
    expect(res.status).toBe(200);
    expect(errors).toHaveLength(1);
  });

  it("reports sink failures on stderr by default", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await new Auditor({ write: () => Promise.reject(new Error("x")) }).around(
        { method: "GET", url: "/" },
        async () => ({ status: 200 })
      );
      expect(spy.mock.calls[0]?.[0]).toMatch(/^\[ynm-mcp audit\]/);
    } finally {
      spy.mockRestore();
    }
  });

  it("awaits the sink before resolving", async () => {
    let written = false;
    const auditor = new Auditor({
      write: async () => {
        await new Promise((r) => setTimeout(r, 10));
        written = true;
      },
    });
    await auditor.around({ method: "GET", url: "/" }, async () => ({ status: 200 }));
    expect(written).toBe(true);
  });
});

describe("runAudited and recordCall", () => {
  it("returns the result and the calls made inside", async () => {
    const { result, calls } = await runAudited(async () => {
      await tick();
      recordCall({ tool: "resource:ynm://memory/{id}", status: "ok", memoryIds: ["01M"] });
      return 42;
    });
    expect(result).toBe(42);
    expect(calls).toEqual([
      { tool: "resource:ynm://memory/{id}", status: "ok", memoryIds: ["01M"] },
    ]);
  });

  it("is a no-op outside a request", () => {
    expect(() => recordCall({ tool: "memory_recall", status: "ok" })).not.toThrow();
  });

  it("measures JSON size in bytes", () => {
    expect(jsonBytes({ text: "é" })).toBe(13);
    expect(jsonBytes(undefined)).toBe(4);
  });
});

const sample = (id: string): AuditEvent => ({
  at: "2026-10-01T09:14:03.120Z",
  id,
  method: "POST",
  path: "/mcp",
  status: 200,
  outcome: "ok",
  calls: [],
  durationMs: 1,
});

describe("stdoutSink", () => {
  it("writes exactly one JSON line per event", async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string,
      cb?: (err?: Error | null) => void
    ) => {
      chunks.push(chunk);
      cb?.();
      return true;
    }) as typeof process.stdout.write);
    try {
      await stdoutSink().write(sample("A"));
    } finally {
      spy.mockRestore();
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.endsWith("\n")).toBe(true);
    expect(chunks[0]?.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(chunks[0] as string)).toEqual(sample("A"));
  });
});

describe("fileSink", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ynm-audit-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const lines = async (p: string) =>
    (await readFile(p, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).id);

  it("creates parent directories and appends JSONL", async () => {
    const path = join(dir, "a", "b", "audit.jsonl");
    const sink = fileSink(path);
    await Promise.all([sink.write(sample("1")), sink.write(sample("2"))]);
    expect(await lines(path)).toEqual(["1", "2"]);
  });

  it("rotates to .1 once the file reaches maxBytes, replacing the old .1", async () => {
    const path = join(dir, "audit.jsonl");
    await writeFile(`${path}.1`, "old\n");
    const size = Buffer.byteLength(`${JSON.stringify(sample("1"))}\n`);
    const sink = fileSink(path, { maxBytes: size * 2 });
    for (const id of ["1", "2", "3", "4", "5"]) await sink.write(sample(id));
    expect(await lines(`${path}.1`)).toEqual(["3", "4"]);
    expect(await lines(path)).toEqual(["5"]);
  });
});

describe("auditSinkFromEnv", () => {
  const fakeS3 = () => {
    const opened: unknown[] = [];
    const load = async () => ({
      s3AuditSink: (opts: unknown) => {
        opened.push(opts);
        return { write: async () => {} };
      },
    });
    return { opened, load: load as never };
  };

  it("defaults to stdout when authenticated and off otherwise", async () => {
    expect(await auditSinkFromEnv({}, { authenticated: true })).toBeDefined();
    expect(await auditSinkFromEnv({}, { authenticated: false })).toBeUndefined();
    expect(await auditSinkFromEnv({ YNM_AUDIT: " " }, { authenticated: false })).toBeUndefined();
  });

  it("turns off, and turns on stdout explicitly", async () => {
    expect(
      await auditSinkFromEnv({ YNM_AUDIT: '{"sink":"off"}' }, { authenticated: true })
    ).toBeUndefined();
    expect(
      await auditSinkFromEnv({ YNM_AUDIT: '{"sink":"stdout"}' }, { authenticated: false })
    ).toBeDefined();
  });

  it("needs a path for the file sink", async () => {
    await expect(
      auditSinkFromEnv({ YNM_AUDIT: '{"sink":"file"}' }, { authenticated: true })
    ).rejects.toThrow(/YNM_AUDIT.*path/);
    const path = join(tmpdir(), `ynm-audit-env-${process.pid}`, "a.jsonl");
    const sink = await auditSinkFromEnv(
      { YNM_AUDIT: JSON.stringify({ sink: "file", path }) },
      { authenticated: false }
    );
    expect(sink).toBeDefined();
  });

  it("rejects invalid JSON, unknown sinks and unknown keys, naming the allowed values", async () => {
    for (const raw of ["{", '{"sink":"syslog"}', '{"sink":"file","pth":"x"}', "[]"])
      await expect(auditSinkFromEnv({ YNM_AUDIT: raw }, { authenticated: true })).rejects.toThrow(
        /YNM_AUDIT.*stdout, file, s3, off/
      );
  });

  it("defaults the s3 bucket to the store's and the prefix to audit/<store prefix>", async () => {
    const s3 = fakeS3();
    await auditSinkFromEnv(
      { YNM_AUDIT: '{"sink":"s3"}' },
      { authenticated: true, s3Store: { bucket: "mem", prefix: "/team/", region: "eu-west-2" } },
      s3.load
    );
    expect(s3.opened).toEqual([{ bucket: "mem", prefix: "audit/team", region: "eu-west-2" }]);
  });

  it("uses audit as the prefix when the store has none or is not on S3", async () => {
    const s3 = fakeS3();
    await auditSinkFromEnv(
      { YNM_AUDIT: '{"sink":"s3"}' },
      { authenticated: true, s3Store: { bucket: "mem", prefix: "" } },
      s3.load
    );
    await auditSinkFromEnv(
      { YNM_AUDIT: '{"sink":"s3","bucket":"logs","region":"us-east-1"}' },
      { authenticated: true },
      s3.load
    );
    expect(s3.opened).toEqual([
      { bucket: "mem", prefix: "audit", region: undefined },
      { bucket: "logs", prefix: "audit", region: "us-east-1" },
    ]);
  });

  it("needs a bucket when the store is not on S3", async () => {
    await expect(
      auditSinkFromEnv({ YNM_AUDIT: '{"sink":"s3"}' }, { authenticated: true }, fakeS3().load)
    ).rejects.toThrow(/YNM_AUDIT.*bucket/);
  });

  it("refuses an explicit prefix under the store's prefix in the same bucket", async () => {
    const store = { bucket: "mem", prefix: "team" };
    for (const prefix of ["team", "team/audit", ""])
      await expect(
        auditSinkFromEnv(
          { YNM_AUDIT: JSON.stringify({ sink: "s3", prefix }) },
          { authenticated: true, s3Store: store },
          fakeS3().load
        )
      ).rejects.toThrow(/YNM_AUDIT/);
    const s3 = fakeS3();
    await auditSinkFromEnv(
      { YNM_AUDIT: JSON.stringify({ sink: "s3", bucket: "other", prefix: "team" }) },
      { authenticated: true, s3Store: store },
      s3.load
    );
    expect(s3.opened).toEqual([{ bucket: "other", prefix: "team", region: undefined }]);
  });

  it("explains when the s3 provider is missing from the build", async () => {
    await expect(
      auditSinkFromEnv({ YNM_AUDIT: '{"sink":"s3","bucket":"b"}' }, { authenticated: true }, () =>
        Promise.reject(new Error("not here"))
      )
    ).rejects.toThrow(/YNM_AUDIT: the s3 audit sink is not available.*not here/);
  });
});
