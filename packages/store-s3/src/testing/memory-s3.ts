import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { S3Command, S3Like } from "../s3-log.js";

interface Version {
  versionId: string;
  body: string | null; // null for a delete marker
  etag: string;
}

export interface MemoryS3Options {
  /** Keep every version of an object, as a versioned bucket does. */
  versioned?: boolean;
  /** Largest page a listing returns, so tests exercise pagination. Default 1000. */
  pageSize?: number;
}

/** An error shaped like the SDK's service exceptions: a name and an HTTP status. */
export function s3Error(name: string, status: number, message = name): Error {
  const err = new Error(message) as Error & { $metadata: { httpStatusCode: number } };
  err.name = name;
  err.$metadata = { httpStatusCode: status };
  return err;
}

function etagOf(body: string): string {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}

/**
 * An in-memory S3 bucket implementing the calls the s3 provider sends, with S3's conditional
 * write semantics: `If-None-Match: *` fails with 412 when the key exists, `If-Match` fails with
 * 412 on a different ETag and 404 on a missing key. Every call yields to the event loop first, so
 * parallel writers interleave. `before` runs ahead of each call, for tests that race a command.
 */
export class MemoryS3 implements S3Like {
  readonly objects = new Map<string, Version[]>();
  readonly calls: string[] = [];
  before?: (command: S3Command) => Promise<void> | void;
  private seq = 0;

  constructor(private readonly options: MemoryS3Options = {}) {}

  private get pageSize(): number {
    return this.options.pageSize ?? 1000;
  }

  private latest(key: string): Version | undefined {
    const v = this.objects.get(key)?.at(-1);
    return v && v.body !== null ? v : undefined;
  }

  private write(key: string, body: string | null): Version {
    const versionId = this.options.versioned ? `v${++this.seq}` : "null";
    const version: Version = { versionId, body, etag: body === null ? "" : etagOf(body) };
    const list = this.objects.get(key) ?? [];
    if (this.options.versioned) list.push(version);
    else list.splice(0, list.length, version);
    this.objects.set(key, list);
    return version;
  }

  /** Every current key, sorted. */
  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix) && this.latest(k)).sort();
  }

  /** Writes an object directly, bypassing conditions; for tests that plant raw bytes. */
  plant(key: string, body: string): void {
    this.write(key, body);
  }

  async send(command: S3Command): Promise<unknown> {
    await new Promise((r) => setImmediate(r));
    this.calls.push(command.constructor.name);
    await this.before?.(command);
    if (command instanceof PutObjectCommand) {
      const { Key, Body, IfNoneMatch, IfMatch } = command.input;
      const key = Key as string;
      const current = this.latest(key);
      if (IfNoneMatch === "*" && current) throw s3Error("PreconditionFailed", 412);
      if (IfMatch !== undefined) {
        if (!current) throw s3Error("NoSuchKey", 404);
        if (current.etag !== IfMatch) throw s3Error("PreconditionFailed", 412);
      }
      const v = this.write(key, String(Body));
      return { ETag: v.etag, VersionId: v.versionId };
    }
    if (command instanceof GetObjectCommand) {
      const v = this.latest(command.input.Key as string);
      if (!v) throw s3Error("NoSuchKey", 404);
      const text = v.body as string;
      return { ETag: v.etag, Body: { transformToString: async () => text } };
    }
    if (command instanceof HeadObjectCommand) {
      const v = this.latest(command.input.Key as string);
      if (!v) throw s3Error("NotFound", 404);
      return { ETag: v.etag };
    }
    if (command instanceof DeleteObjectCommand) {
      const { Key, VersionId } = command.input;
      const key = Key as string;
      const list = this.objects.get(key);
      if (VersionId !== undefined) {
        const i = list?.findIndex((v) => v.versionId === VersionId) ?? -1;
        if (list && i >= 0) list.splice(i, 1);
        if (list?.length === 0) this.objects.delete(key);
      } else if (this.options.versioned) {
        if (list) this.write(key, null);
      } else this.objects.delete(key);
      return {};
    }
    if (command instanceof ListObjectsV2Command) {
      const { Prefix, ContinuationToken, MaxKeys } = command.input;
      const after = ContinuationToken ? Buffer.from(ContinuationToken, "base64").toString() : "";
      const all = this.keys(Prefix ?? "").filter((k) => k > after);
      const page = all.slice(0, Math.min(MaxKeys ?? this.pageSize, this.pageSize));
      const truncated = page.length < all.length;
      return {
        Contents: page.map((Key) => ({ Key, ETag: this.latest(Key)?.etag })),
        KeyCount: page.length,
        IsTruncated: truncated,
        NextContinuationToken: truncated
          ? Buffer.from(page.at(-1) as string).toString("base64")
          : undefined,
      };
    }
    if (command instanceof ListObjectVersionsCommand) {
      const { Prefix, KeyMarker, VersionIdMarker } = command.input;
      const entries: Array<{ key: string; v: Version; latest: boolean }> = [];
      for (const key of [...this.objects.keys()].sort()) {
        if (!key.startsWith(Prefix ?? "")) continue;
        const list = this.objects.get(key) as Version[];
        // S3 lists the newest version of a key first.
        for (let i = list.length - 1; i >= 0; i--)
          entries.push({ key, v: list[i] as Version, latest: i === list.length - 1 });
      }
      let start = 0;
      if (KeyMarker !== undefined) {
        const i = entries.findIndex(
          (e) => e.key === KeyMarker && e.v.versionId === VersionIdMarker
        );
        start = i + 1;
      }
      const page = entries.slice(start, start + this.pageSize);
      const truncated = start + page.length < entries.length;
      const last = page.at(-1);
      return {
        Versions: page
          .filter((e) => e.v.body !== null)
          .map((e) => ({
            Key: e.key,
            VersionId: e.v.versionId,
            IsLatest: e.latest,
            ETag: e.v.etag,
          })),
        DeleteMarkers: page
          .filter((e) => e.v.body === null)
          .map((e) => ({ Key: e.key, VersionId: e.v.versionId, IsLatest: e.latest })),
        IsTruncated: truncated,
        NextKeyMarker: truncated ? last?.key : undefined,
        NextVersionIdMarker: truncated ? last?.v.versionId : undefined,
      };
    }
    if (command instanceof GetBucketVersioningCommand) {
      return this.options.versioned ? { Status: "Enabled" } : {};
    }
    throw new Error(`MemoryS3: unsupported command ${(command as object).constructor.name}`);
  }
}
