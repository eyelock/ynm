/**
 * @ynm/store-s3: the `s3` record log provider (ADR-004). A package of its own so the AWS SDK
 * stays out of the CLI bundles; the service loads it with a dynamic import when a mount asks.
 */
import { S3Client } from "@aws-sdk/client-s3";
import type { Level } from "@ynm/model";
import { S3Log } from "./s3-log.js";

export * from "./s3-log.js";

export interface S3MountConfig {
  bucket: string;
  prefix?: string;
  /** AWS region; when unset, the SDK reads AWS_REGION and the shared config. */
  region?: string;
}

/** An S3Log over the SDK's client, with credentials from the standard AWS provider chain. */
export function openS3Log(id: string, level: Level, config: S3MountConfig): S3Log {
  const client = new S3Client(config.region ? { region: config.region } : {});
  return new S3Log(id, level, { client, bucket: config.bucket, prefix: config.prefix });
}
