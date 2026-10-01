#!/usr/bin/env node
// A local S3 (MinIO in Docker) for developing and trying the s3 provider. Needs Docker and a
// built checkout (`make build`), because it creates the bucket with the AWS SDK that
// @ynm/store-s3 depends on.
//   node infra/minio/minio.mjs up      start it, wait, create the versioned bucket
//   node infra/minio/minio.mjs env     print the exports a shell needs to mount it
//   node infra/minio/minio.mjs down    stop it and throw its data away
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const NAME = "ynm-minio";
const IMAGE = "cgr.dev/chainguard/minio:latest";
const PORT = process.env.MINIO_PORT ?? "9000";
const USER = "ynm";
const PASS = "ynm-dev-secret";
const BUCKET = process.env.MINIO_BUCKET ?? "ynm-dev";
const ENDPOINT = `http://localhost:${PORT}`;

const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });

async function up() {
  if (docker("inspect", NAME).status !== 0) {
    const r = docker(
      "run", "-d", "--name", NAME, "-p", `${PORT}:9000`,
      "-e", `MINIO_ROOT_USER=${USER}`, "-e", `MINIO_ROOT_PASSWORD=${PASS}`,
      // Virtual-hosted addressing (bucket.localhost), which the SDK uses by default.
      "-e", "MINIO_DOMAIN=localhost",
      IMAGE, "server", "/data"
    );
    if (r.status !== 0) throw new Error(`docker run: ${r.stderr.trim()}`);
  }
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${ENDPOINT}/minio/health/live`)).ok) break;
    } catch {}
    if (Date.now() > until) throw new Error("MinIO did not start within 60 s");
    await new Promise((r) => setTimeout(r, 500));
  }
  const require = createRequire(new URL("../../packages/store-s3/package.json", import.meta.url));
  const { S3Client, CreateBucketCommand, PutBucketVersioningCommand } =
    require("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint: ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: USER, secretAccessKey: PASS },
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (err) {
    if (err?.name !== "BucketAlreadyOwnedByYou") throw err;
  }
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: BUCKET,
      VersioningConfiguration: { Status: "Enabled" },
    })
  );
  console.log(`MinIO at ${ENDPOINT}, bucket ${BUCKET} (versioned). In a shell:`);
  console.log("  eval \"$(make minio-env)\"");
}

function env() {
  const mounts = [{ id: "hosted", level: "distributed", provider: "s3", bucket: BUCKET, prefix: "dev" }];
  for (const [k, v] of Object.entries({
    AWS_ACCESS_KEY_ID: USER,
    AWS_SECRET_ACCESS_KEY: PASS,
    AWS_REGION: "us-east-1",
    AWS_ENDPOINT_URL_S3: ENDPOINT,
    YNM_MOUNTS: JSON.stringify(mounts),
  })) {
    console.log(`export ${k}='${v}'`);
  }
}

function down() {
  docker("rm", "-f", NAME);
  console.log(`removed ${NAME}`);
}

const command = process.argv[2];
try {
  if (command === "up") await up();
  else if (command === "env") env();
  else if (command === "down") down();
  else throw new Error("usage: minio.mjs up | env | down");
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
