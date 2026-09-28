import type { MemoryRecord } from "@ynm/model";
import { ulid } from "@ynm/model";
import {
  assertLevel,
  bucketOf,
  groupByShard,
  namespaceMatches,
  shardId,
  shardMatches,
} from "./log.js";

function rec(over: Partial<MemoryRecord> = {}): MemoryRecord {
  const id = ulid();
  return {
    v: 1,
    id,
    memoryId: id,
    op: "create",
    type: "semantic",
    level: "personal",
    namespace: "user/david",
    tags: [],
    links: [],
    content: "x",
    recordedAt: "2026-09-29T10:00:00.000Z",
    provenance: { actor: "test" },
    ...over,
  };
}

describe("shards", () => {
  it("buckets by month of recordedAt", () => {
    expect(bucketOf("2026-09-29T10:00:00.000Z")).toBe("2026-09");
  });
  it("identifies a shard by level, namespace, type and bucket", () => {
    expect(
      shardId({ level: "personal", namespace: "user/david", type: "semantic", bucket: "2026-09" })
    ).toBe("personal/user/david/semantic/2026-09");
  });
  it("matches namespace prefixes on whole segments", () => {
    expect(namespaceMatches("org/eyelock/x", "org/eyelock")).toBe(true);
    expect(namespaceMatches("org/eyelockx", "org/eyelock")).toBe(false);
    expect(namespaceMatches("org/eyelock", "org/eyelock")).toBe(true);
    expect(namespaceMatches("anything", undefined)).toBe(true);
  });
  it("filters shards by level, type, namespace and bucket range", () => {
    const key = {
      level: "personal" as const,
      namespace: "user/david",
      type: "semantic" as const,
      bucket: "2026-09",
    };
    expect(shardMatches(key, { level: "distributed" })).toBe(false);
    expect(shardMatches(key, { type: "episodic" })).toBe(false);
    expect(shardMatches(key, { namespace: "user" })).toBe(true);
    expect(shardMatches(key, { fromBucket: "2026-10" })).toBe(false);
    expect(shardMatches(key, { toBucket: "2026-08" })).toBe(false);
    expect(shardMatches(key, undefined)).toBe(true);
  });
  it("groups records by shard preserving order", () => {
    const a = rec();
    const b = rec({ type: "episodic" });
    const c = rec();
    const groups = groupByShard([a, b, c]);
    expect(groups.size).toBe(2);
    expect(groups.get("personal/user/david/semantic/2026-09")?.records).toEqual([a, c]);
  });
  it("refuses a record whose level differs from the log's (ADR-001)", () => {
    expect(() => assertLevel({ id: "shared", level: "distributed" }, [rec()])).toThrow(
      /refusing a personal record/
    );
  });
});
