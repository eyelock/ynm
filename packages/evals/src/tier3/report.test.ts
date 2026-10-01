import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BenchReport } from "./driver.js";
import { REPORTS_DIR, readReport, reportPath, writeReport } from "./report.js";

const report = (cases: number): BenchReport => ({
  dataset: "locomo" as BenchReport["dataset"],
  datasetSha256: "abc",
  datasetLicense: "CC",
  ranAt: "2026-01-01T00:00:00Z",
  ynmVersion: "0.0.0-test",
  setup: { ingest: "turn-episodic", index: "fts", k: 10, cases, questions: cases },
  retrieval: { evidenceRecallAtK: 0.5, fullEvidenceAtK: 0.4, byCategory: {} },
  timing: { ingestMs: 1, memories: 1, recallMs: 1 },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ynm-reports-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("report location", () => {
  it("defaults to the package reports directory", () => {
    expect(reportPath("1.0.0", "x")).toBe(join(REPORTS_DIR, "1.0.0", "x.json"));
  });

  it("writes and reads an injected directory", () => {
    const file = writeReport(report(3), { dir });
    expect(file).toBe(join(dir, "0.0.0-test", "locomo.json"));
    expect(readReport("0.0.0-test", "locomo", { dir })?.setup.cases).toBe(3);
    expect(readReport("0.0.0-test", "locomo")).toBeUndefined();
  });
});
