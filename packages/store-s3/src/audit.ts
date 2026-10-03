import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { S3Like } from "./s3-log.js";

/**
 * The fields of an audit event this sink needs. The full event type lives in @ynm/mcp; this
 * package does not depend on it, so the sink takes any JSON object with an id and a time.
 */
export interface S3AuditEvent {
  id: string;
  /** ISO time; its UTC date picks the folder. */
  at: string;
}

export interface S3AuditSinkOptions {
  /** Defaults to an SDK client with credentials from the standard AWS provider chain. */
  client?: S3Like;
  bucket: string;
  /** Key prefix the date folders sit under; leading and trailing slashes are ignored. */
  prefix: string;
  /** AWS region for the default client; when unset, the SDK reads AWS_REGION. */
  region?: string;
}

export interface S3AuditSink {
  write(event: S3AuditEvent): Promise<void>;
}

/** `<prefix>/<yyyy>/<mm>/<dd>/<id>.json`, so one lifecycle rule sets retention by day. */
export function auditKey(prefix: string, event: S3AuditEvent): string {
  const at = new Date(event.at);
  if (Number.isNaN(at.getTime()))
    throw new Error(`audit event ${event.id}: invalid time ${event.at}`);
  const yyyy = String(at.getUTCFullYear()).padStart(4, "0");
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(at.getUTCDate()).padStart(2, "0");
  const base = prefix.replace(/^\/+|\/+$/g, "");
  return `${base ? `${base}/` : ""}${yyyy}/${mm}/${dd}/${event.id}.json`;
}

/**
 * One object per audit event. The put is conditional (`If-None-Match: *`) like the record log's,
 * so an event id that somehow repeats fails loudly instead of overwriting an earlier event.
 */
export function s3AuditSink(options: S3AuditSinkOptions): S3AuditSink {
  const client = options.client ?? new S3Client(options.region ? { region: options.region } : {});
  return {
    async write(event) {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: auditKey(options.prefix, event),
          Body: JSON.stringify(event),
          ContentType: "application/json",
          IfNoneMatch: "*",
        })
      );
    },
  };
}
