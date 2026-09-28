import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ynm } from "../../test/helpers.js";

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
    expect(parsed.version).toBe("0.1.0");
    expect(parsed.mounts.map((m) => m.id)).toEqual(["personal"]);
  });
});
