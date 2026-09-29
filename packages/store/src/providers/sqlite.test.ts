import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRecordLogConformance } from "../testing/conformance.js";
import { SqliteLog } from "./sqlite.js";

const writer = fileURLToPath(new URL("../../test/fixtures/sqlite-writer.mjs", import.meta.url));

runRecordLogConformance("sqlite", {
  create: async (level) =>
    new SqliteLog(
      `sqlite-${level}`,
      level,
      join(mkdtempSync(join(tmpdir(), "ynm-sqlite-")), "store.sqlite")
    ),
  corrupt: async (log, record) => {
    const db = (log as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    db.prepare(
      "INSERT INTO records (id, memoryId, shard, level, namespace, type, bucket, recordedAt, line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "BROKEN0000000000000000000000",
      "BROKEN",
      `${record.level}/${record.namespace}/${record.type}/${record.recordedAt.slice(0, 7)}`,
      record.level,
      record.namespace,
      record.type,
      record.recordedAt.slice(0, 7),
      record.recordedAt,
      "{broken"
    );
  },
  concurrentWriters: async (log, n, perWriter) => {
    await Promise.all(
      Array.from({ length: n }, (_, i) => {
        return new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [writer, (log as SqliteLog).file, String(i), String(perWriter)],
            { stdio: ["ignore", "ignore", "pipe"] }
          );
          let err = "";
          child.stderr.on("data", (d) => {
            err += d;
          });
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err))));
        });
      })
    );
  },
});
