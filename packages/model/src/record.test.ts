import {
  AnnotateInputSchema,
  MemoryRecordSchema,
  NamespaceSchema,
  RememberInputSchema,
  sessionNamespace,
  summarize,
} from "./record.js";
import { ulid } from "./ulid.js";

const now = new Date().toISOString();

function base(over: Record<string, unknown> = {}) {
  const id = ulid();
  return {
    v: 1,
    id,
    memoryId: id,
    op: "create",
    type: "semantic",
    level: "personal",
    namespace: "user/david",
    content: "Root commit is the anchor.",
    recordedAt: now,
    provenance: { actor: "test" },
    ...over,
  };
}

describe("NamespaceSchema (ADR-001)", () => {
  it.each(["common", "user/david", "org/eyelock/team/platform/project/ynm", "a.b-c_d/e"])(
    "accepts %s",
    (ns) => {
      expect(NamespaceSchema.safeParse(ns).success).toBe(true);
    }
  );
  it.each([
    "",
    "/leading",
    "trailing/",
    "Upper/case",
    "a//b",
    "spa ce",
    "a/b/../c",
    ".hidden",
    "x/a..b",
    "a.lock",
  ])("rejects %s", (ns) => {
    expect(NamespaceSchema.safeParse(ns).success).toBe(false);
  });
  it("is unbounded in depth", () => {
    expect(
      NamespaceSchema.safeParse(Array.from({ length: 40 }, (_, i) => `l${i}`).join("/")).success
    ).toBe(true);
  });
});

describe("MemoryRecordSchema (ADR-002)", () => {
  it("accepts a create record and defaults tags and links", () => {
    const r = MemoryRecordSchema.parse(base());
    expect(r.tags).toEqual([]);
    expect(r.links).toEqual([]);
  });

  it("requires content on create and supersede", () => {
    expect(MemoryRecordSchema.safeParse(base({ content: undefined })).success).toBe(false);
  });

  it("requires memoryId === id on create", () => {
    expect(MemoryRecordSchema.safeParse(base({ memoryId: ulid() })).success).toBe(false);
  });

  it("requires a supersedes link on supersede", () => {
    const prior = ulid();
    const bad = base({ op: "supersede", memoryId: prior });
    expect(MemoryRecordSchema.safeParse(bad).success).toBe(false);
    const good = base({
      op: "supersede",
      memoryId: prior,
      links: [{ rel: "supersedes", to: prior }],
    });
    expect(MemoryRecordSchema.safeParse(good).success).toBe(true);
  });

  it("confines working memory to session namespaces", () => {
    expect(MemoryRecordSchema.safeParse(base({ type: "working" })).success).toBe(false);
    expect(
      MemoryRecordSchema.safeParse(base({ type: "working", namespace: "session/abc", ttl: "PT1H" }))
        .success
    ).toBe(true);
  });

  it("rejects unknown fields so the log stays clean", () => {
    expect(MemoryRecordSchema.safeParse(base({ extra: 1 })).success).toBe(false);
  });

  it("accepts a structured data payload with a schema tag", () => {
    const r = MemoryRecordSchema.parse(
      base({ data: { role: "engineer" }, dataSchema: "user-profile/1" })
    );
    expect(r.data).toEqual({ role: "engineer" });
  });
});

describe("input schemas", () => {
  it("RememberInput defaults level, namespace, importance and confidence", () => {
    const i = RememberInputSchema.parse({ type: "episodic", content: "x" });
    expect(i.level).toBe("personal");
    expect(i.namespace).toBe("common");
    expect(i.importance).toBe(0.5);
    expect(i.confidence).toBe(1);
  });
  it("RememberInput gives working memory a default TTL and keeps an explicit one", () => {
    const base = { type: "working", namespace: "session/abc", content: "x" };
    expect(RememberInputSchema.parse(base).ttl).toBe("PT8H");
    expect(RememberInputSchema.parse({ ...base, ttl: "PT1H" }).ttl).toBe("PT1H");
    expect(RememberInputSchema.parse({ type: "semantic", content: "x" }).ttl).toBeUndefined();
  });
  it("AnnotateInput needs a memoryId", () => {
    expect(AnnotateInputSchema.safeParse({ pinned: true }).success).toBe(false);
  });
});

describe("sessionNamespace", () => {
  it("normalises ids into valid namespace segments", () => {
    for (const id of ["01M3N5DKQZPVDY9DMKV7YBZ341", "My Session!", "a/b", "..x"]) {
      expect(NamespaceSchema.safeParse(sessionNamespace(id)).success, id).toBe(true);
    }
    expect(sessionNamespace("01M3N5DKQZ")).toBe("session/01m3n5dkqz");
  });
});

describe("summarize", () => {
  it("takes the first non-empty line without a heading marker", () => {
    expect(summarize("\n# Title here\nbody")).toBe("Title here");
  });
  it("truncates to 280 characters", () => {
    expect(summarize("x".repeat(400))).toHaveLength(280);
  });
});
