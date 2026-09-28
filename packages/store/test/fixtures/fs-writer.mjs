// External writer used by the fs conformance test: appends records from a separate process.
import { ulid } from "@ynm/model";
import { FsLog } from "../../dist/providers/fs.js";

const [dir, writerId, count] = process.argv.slice(2);
const log = new FsLog("fs-personal", "personal", dir);
const base = 1_800_000_000_000 + Number(writerId) * 100_000;
for (let i = 0; i < Number(count); i++) {
  const id = ulid(base + i);
  await log.append([
    {
      v: 1,
      id,
      memoryId: id,
      op: "create",
      type: "semantic",
      level: "personal",
      namespace: "user/test",
      tags: [],
      links: [],
      content: `w${writerId}-${i}`,
      recordedAt: "2026-09-20T00:00:00.000Z",
      provenance: { actor: `writer-${writerId}` },
    },
  ]);
}
