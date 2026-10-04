import { PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { auditKey, s3AuditSink } from "./index.js";
import type { S3Command } from "./s3-log.js";
import { MemoryS3 } from "./testing/memory-s3.js";

const event = { id: "01JABCDEFGHJKMNPQRSTVWXYZ0", at: "2026-10-01T23:59:59.000Z", status: 200 };

describe("s3AuditSink", () => {
  it("writes one object per event under a UTC date folder", async () => {
    const s3 = new MemoryS3();
    const sink = s3AuditSink({ client: s3, bucket: "b", prefix: "/audit/team/" });
    await sink.write(event);
    await sink.write({ ...event, id: "01JABCDEFGHJKMNPQRSTVWXYZ1", at: "2026-10-02T00:00:00Z" });
    expect(s3.keys()).toEqual([
      "audit/team/2026/10/01/01JABCDEFGHJKMNPQRSTVWXYZ0.json",
      "audit/team/2026/10/02/01JABCDEFGHJKMNPQRSTVWXYZ1.json",
    ]);
    const obj = s3.objects.get("audit/team/2026/10/01/01JABCDEFGHJKMNPQRSTVWXYZ0.json");
    expect(JSON.parse(obj?.[0]?.body as string)).toEqual(event);
  });

  it("puts conditionally as JSON", async () => {
    const s3 = new MemoryS3();
    const seen: PutObjectCommand[] = [];
    s3.before = (c: S3Command) => {
      if (c instanceof PutObjectCommand) seen.push(c);
    };
    await s3AuditSink({ client: s3, bucket: "b", prefix: "audit" }).write(event);
    expect(seen[0]?.input).toMatchObject({
      Bucket: "b",
      Key: "audit/2026/10/01/01JABCDEFGHJKMNPQRSTVWXYZ0.json",
      IfNoneMatch: "*",
      ContentType: "application/json",
    });
  });

  it("refuses to overwrite an existing event", async () => {
    const s3 = new MemoryS3();
    const sink = s3AuditSink({ client: s3, bucket: "b", prefix: "audit" });
    await sink.write(event);
    await expect(sink.write(event)).rejects.toThrow(/PreconditionFailed/);
  });

  it("builds keys with an empty prefix and rejects a bad time", () => {
    expect(auditKey("", event)).toBe("2026/10/01/01JABCDEFGHJKMNPQRSTVWXYZ0.json");
    expect(() => auditKey("a", { id: "x", at: "nope" })).toThrow(/invalid time/);
  });
});
