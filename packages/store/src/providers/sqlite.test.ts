import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collect, makeRecord, runRecordLogConformance } from "../testing/conformance.js";
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

describe("SqliteLog specifics", () => {
  function fresh(): SqliteLog {
    return new SqliteLog(
      "s",
      "personal",
      join(mkdtempSync(join(tmpdir(), "ynm-sqlite-")), "a", "b.sqlite")
    );
  }

  it("creates the parent directory, and an empty append touches no shard", async () => {
    const log = fresh();
    expect(await log.append([])).toEqual({ appended: 0, shards: [] });
    expect(await log.shards()).toEqual([]);
    log.close();
  });

  it("works with an in-memory database", async () => {
    const log = new SqliteLog("m", "personal", ":memory:");
    await log.append([makeRecord()]);
    expect(await collect(log)).toHaveLength(1);
    expect((await log.health()).details).toMatchObject({ file: ":memory:", records: 1, shards: 1 });
    log.close();
  });

  it("rolls back the whole batch when a record cannot be written", async () => {
    const log = fresh();
    const good = makeRecord();
    const bad = { ...makeRecord(), data: { n: 1n } } as unknown as typeof good;
    await expect(log.append([good, bad])).rejects.toThrow(/BigInt/);
    expect(await collect(log)).toEqual([]);
    expect(await log.shards()).toEqual([]);
    // The log is still usable after the rollback.
    expect((await log.append([good])).appended).toBe(1);
    log.close();
  });

  it("closes the database", async () => {
    const log = fresh();
    log.close();
    await expect(log.append([makeRecord()])).rejects.toThrow(/not open/);
  });
});
