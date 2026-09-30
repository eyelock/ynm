import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolSpec } from "@ynm/service";
import { ynm } from "../../test/helpers.js";
import Status from "./status.js";

describe("status description", () => {
  it("is the memory_status tool's description", () => {
    expect(Status.description).toBe(toolSpec("memory_status")?.description);
    expect(Status.description).toBeTruthy();
  });
});

describe("ynm status", () => {
  it("reports name, version and the personal mount as JSON", () => {
    const { stdout, status } = ynm(mkdtempSync(join(tmpdir(), "ynm-nogit-")), "status", "--json");
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as {
      name: string;
      version: string;
      mounts: Array<{ id: string }>;
    };
    expect(parsed.name).toBe("ynm");
    expect(parsed.version).toBe(
      (
        JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as {
          version: string;
        }
      ).version
    );
    expect((parsed as { index: unknown[] }).index).toHaveLength(1);
    expect(parsed.mounts.map((m) => m.id)).toEqual(["personal"]);
  });
});
