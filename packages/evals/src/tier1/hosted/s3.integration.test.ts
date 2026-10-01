import { spawnSync } from "node:child_process";
import {
  CreateBucketCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { collect, makeRecord, runRecordLogConformance } from "@ynm/store/testing";
import { S3Log } from "@ynm/store-s3";
import { docker, dockerAvailable, hostPort, waitFor } from "./docker.js";

const available = dockerAvailable();
// MinIO no longer publishes images to Docker Hub; Chainguard publishes a current build.
const IMAGE = "cgr.dev/chainguard/minio:latest";
const USER = "ynm";
const PASS = "ynm-pass-123";
const BUCKET = "ynm-store";

/**
 * The s3 provider against a real S3 implementation: MinIO in a container, which honours
 * `If-None-Match` and `If-Match` on PUT, on a versioned bucket. The same conformance suite the
 * in-memory double runs, with real parallel writers over HTTP.
 */
describe.skipIf(!available)("s3 provider on a MinIO container", () => {
  let container = "";
  let client: S3Client;
  let run = 0;

  beforeAll(async () => {
    container = docker(
      "run",
      "-d",
      "--rm",
      "-p",
      "127.0.0.1:0:9000",
      "-e",
      `MINIO_ROOT_USER=${USER}`,
      "-e",
      `MINIO_ROOT_PASSWORD=${PASS}`,
      IMAGE,
      "server",
      "/tmp/data"
    );
    const port = hostPort(container, 9000);
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${port}/minio/health/live`)).ok,
      60_000,
      "minio"
    );
    client = new S3Client({
      endpoint: `http://127.0.0.1:${port}`,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: USER, secretAccessKey: PASS },
    });
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    await client.send(
      new PutBucketVersioningCommand({
        Bucket: BUCKET,
        VersioningConfiguration: { Status: "Enabled" },
      })
    );
  }, 300_000);

  afterAll(() => {
    client?.destroy();
    if (container) spawnSync("docker", ["stop", "-t", "2", container]);
  });

  const open = (level: "personal" | "distributed") =>
    new S3Log(`minio-${level}`, level, { client, bucket: BUCKET, prefix: `run-${++run}` });

  runRecordLogConformance("s3 on MinIO", {
    create: async (level) => open(level),
    corrupt: async (log, record) => {
      const s3 = log as S3Log;
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: `${s3.prefix}/${record.level}/${record.namespace}/${record.type}/${record.recordedAt.slice(0, 7)}/01ZZZZZZZZZZZZZZZZZZZZZZZZ.jsonl`,
          Body: "{broken\n",
        })
      );
    },
    concurrentWriters: async (log, writers, perWriter) => {
      const base = log as S3Log;
      await Promise.all(
        Array.from({ length: writers }, async (_, w) => {
          const own = new S3Log(base.id, base.level, {
            client,
            bucket: BUCKET,
            prefix: base.prefix,
          });
          for (let i = 0; i < perWriter; i++)
            await own.append([
              makeRecord({ recordedAt: "2026-09-20T00:00:00.000Z", content: `w${w}-${i}` }),
            ]);
        })
      );
    },
  });

  it("reports the bucket's versioning in health", async () => {
    const log = open("personal");
    const res = await log.append([makeRecord()]);
    expect((await log.health()).details).toMatchObject({ versioning: "Enabled", objects: 1 });
    // The revision an append returns is the one a later listing reports, so indexes stay fresh.
    expect((await log.shards())[0]?.revision).toBe(res.shards[0]?.revision);
  });

  it("refuses to overwrite an existing key and to rewrite a changed object", async () => {
    const key = `run-${++run}/probe.jsonl`;
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "a\n" }));
    await expect(
      client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "b\n", IfNoneMatch: "*" }))
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    await expect(
      client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "b\n", IfMatch: '"0"' }))
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
  });

  it("compacts a shard and keeps every record once", async () => {
    const log = open("personal");
    const recs = Array.from({ length: 5 }, () =>
      makeRecord({ recordedAt: "2026-09-20T00:00:00.000Z" })
    );
    for (const r of recs) await log.append([r]);
    const [shard] = await log.shards();
    const res = await log.compact(shard as NonNullable<typeof shard>, { threshold: 2 });
    expect(res).toMatchObject({ compacted: true, inputs: 5 });
    const back = await collect(log);
    expect(back.map((r) => r.id).sort()).toEqual(recs.map((r) => r.id).sort());
    expect((await log.health()).details).toMatchObject({ objects: 1, records: 5 });
  });

  it("purge with forgetHistory leaves no version holding the memory", async () => {
    const log = open("personal");
    const keep = makeRecord({ recordedAt: "2026-09-20T00:00:00.000Z" });
    const gone = makeRecord({ recordedAt: "2026-09-20T00:00:00.000Z" });
    await log.append([keep, gone]);
    expect((await log.purge(gone.memoryId, { forgetHistory: true })).removed).toBe(1);
    const versions = await client.send(
      new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: `${log.prefix}/` })
    );
    expect(versions.Versions).toHaveLength(1);
    expect(versions.DeleteMarkers ?? []).toHaveLength(0);
    expect((await collect(log)).map((r) => r.id)).toEqual([keep.id]);
  });
});
