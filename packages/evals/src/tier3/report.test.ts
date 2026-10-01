import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { BenchReport } from "./driver.js";
import { mergeReports, readReport, reportPath, writeReport } from "./report.js";

const reportsDir = join(import.meta.dirname, "..", "..", "reports");

function report(over: Partial<BenchReport> & { cases?: number } = {}): BenchReport {
  const { cases = 10, ...rest } = over;
  return {
    dataset: "locomo",
    datasetSha256: "sha-1",
    datasetLicense: "CC BY-NC 4.0",
    ranAt: "2026-10-01T00:00:00.000Z",
    ynmVersion: "0.0.0-test",
    setup: { ingest: "turn-episodic", index: "sqlite-fts", k: 10, cases, questions: cases * 3 },
    retrieval: {
      evidenceRecallAtK: cases / 100,
      fullEvidenceAtK: cases / 200,
      byCategory: { "single-hop": { n: cases, evidenceRecall: cases / 100 } },
    },
    timing: { ingestMs: cases * 10, memories: cases * 20, recallMs: cases },
    ...rest,
  };
}

function answering(accuracy: number): NonNullable<BenchReport["answering"]> {
  return { n: 2, accuracy, byCategory: { "single-hop": { n: 2, accuracy } }, samples: [] };
}

describe("tier3 report merging", () => {
  it("takes the new report as is when there is no previous one or the dataset changed", () => {
    const next = report({ cases: 5 });
    expect(mergeReports(undefined, next)).toBe(next);
    const other = report({ cases: 50, datasetSha256: "sha-0", answering: answering(0.9) });
    expect(mergeReports(other, next)).toBe(next);
  });

  it("keeps the wider retrieval run and the earlier paid answers on a small retrieval refresh", () => {
    const wide = report({
      cases: 60,
      answering: answering(0.75),
      setup: {
        ingest: "turn-episodic",
        index: "sqlite-fts",
        k: 10,
        cases: 60,
        questions: 180,
        writer: "claude-cli",
        judge: "typesafe",
        judgeCalibrated: true,
      },
    });
    const refresh = report({ cases: 5, ranAt: "2026-10-02T00:00:00.000Z" });
    const merged = mergeReports(wide, refresh);
    expect(merged.ranAt).toBe("2026-10-02T00:00:00.000Z");
    expect(merged.setup.cases).toBe(60);
    expect(merged.retrieval).toEqual(wide.retrieval);
    expect(merged.timing).toEqual(wide.timing);
    expect(merged.answering).toEqual(answering(0.75));
    expect(merged.setup).toMatchObject({
      writer: "claude-cli",
      judge: "typesafe",
      judgeCalibrated: true,
    });
  });

  it("takes answers from the latest answering run but keeps the wider retrieval sample", () => {
    const wide = report({ cases: 60 });
    const small = report({
      cases: 3,
      answering: answering(0.5),
      setup: {
        ingest: "turn-episodic",
        index: "sqlite-fts",
        k: 10,
        cases: 3,
        questions: 9,
        writer: "fake-writer",
        judge: "fake-judge",
        judgeCalibrated: false,
      },
    });
    const merged = mergeReports(wide, small);
    expect(merged.setup.cases).toBe(60);
    expect(merged.retrieval).toEqual(wide.retrieval);
    expect(merged.answering).toEqual(answering(0.5));
    expect(merged.setup).toMatchObject({
      writer: "fake-writer",
      judge: "fake-judge",
      judgeCalibrated: false,
    });
  });

  it("drops model names from the setup when neither run answered", () => {
    const merged = mergeReports(report({ cases: 4 }), report({ cases: 8 }));
    expect(merged.setup.cases).toBe(8);
    expect(merged.retrieval.evidenceRecallAtK).toBe(0.08);
    expect(merged.answering).toBeUndefined();
    expect(merged.setup.writer).toBeUndefined();
    expect(merged.setup.judge).toBeUndefined();
    expect(merged.setup.judgeCalibrated).toBeUndefined();
  });
});

describe("tier3 report files", () => {
  let tmp: string;
  // Reports live under the package's reports/ dir; a version that walks out of it keeps the
  // committed reports untouched while exercising the real write path.
  let version: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ynm-report-"));
    version = relative(reportsDir, join(tmp, "v"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("places reports per version and dataset", () => {
    expect(reportPath("1.2.3", "locomo")).toBe(join(reportsDir, "1.2.3", "locomo.json"));
    expect(reportPath(version, "locomo")).toBe(join(tmp, "v", "locomo.json"));
  });

  it("reads nothing before a report is written", () => {
    expect(readReport(version, "locomo")).toBeUndefined();
  });

  it("writes a report, then merges a later one into it", () => {
    const first = report({ cases: 40, ynmVersion: version, answering: answering(0.6) });
    const file = writeReport(first);
    expect(file).toBe(join(tmp, "v", "locomo.json"));
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").endsWith("}\n")).toBe(true);
    expect(readReport(version, "locomo")).toEqual(first);

    writeReport(report({ cases: 2, ynmVersion: version, ranAt: "2026-10-03T00:00:00.000Z" }));
    const merged = readReport(version, "locomo");
    expect(merged?.ranAt).toBe("2026-10-03T00:00:00.000Z");
    expect(merged?.setup.cases).toBe(40);
    expect(merged?.answering).toEqual(answering(0.6));
    expect(readReport(version, "longmemeval-s")).toBeUndefined();
  });
});
