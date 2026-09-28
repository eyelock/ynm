import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRecordLogConformance } from "../testing/conformance.js";
import { FsLog } from "./fs.js";

const writer = fileURLToPath(new URL("../../test/fixtures/fs-writer.mjs", import.meta.url));

runRecordLogConformance("fs", {
  create: async (level) => new FsLog(`fs-${level}`, level, mkdtempSync(join(tmpdir(), "ynm-fs-"))),
  corrupt: async (log, record) => {
    const file = join(
      (log as FsLog).dir,
      record.level,
      ...record.namespace.split("/"),
      record.type,
      `${record.recordedAt.slice(0, 7)}.jsonl`
    );
    appendFileSync(file, "{broken\n");
  },
  concurrentWriters: async (log, n, perWriter) => {
    await Promise.all(
      Array.from({ length: n }, (_, i) => {
        return new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [writer, (log as FsLog).dir, String(i), String(perWriter)],
            {
              stdio: ["ignore", "ignore", "pipe"],
            }
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
