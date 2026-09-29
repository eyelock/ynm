import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchReport } from "./driver.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "reports");

/** Reports are committed per release under packages/evals/reports/<version>/<dataset>.json (ADR-014). */
export function reportPath(version: string, dataset: string): string {
  return join(dir, version, `${dataset}.json`);
}

/**
 * Retrieval numbers come from the run that covered the most cases; answering comes from the
 * latest run that answered. So a cheap retrieval-only refresh never drops paid answers, and a
 * small answering run never shrinks the retrieval sample.
 */
export function writeReport(report: BenchReport): string {
  const file = reportPath(report.ynmVersion, report.dataset);
  mkdirSync(dirname(file), { recursive: true });
  const previous = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as BenchReport)
    : undefined;
  const merged = mergeReports(previous, report);
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  return file;
}

export function mergeReports(previous: BenchReport | undefined, report: BenchReport): BenchReport {
  if (!previous || previous.datasetSha256 !== report.datasetSha256) return report;
  const wider = previous.setup.cases > report.setup.cases ? previous : report;
  const answering = report.answering ?? previous.answering;
  const answered = report.answering ? report : previous;
  return {
    ...report,
    setup: {
      ...wider.setup,
      writer: answering ? answered.setup.writer : undefined,
      judge: answering ? answered.setup.judge : undefined,
      judgeCalibrated: answering ? answered.setup.judgeCalibrated : undefined,
    },
    retrieval: wider.retrieval,
    timing: wider.timing,
    answering,
  };
}

export function readReport(version: string, dataset: string): BenchReport | undefined {
  const file = reportPath(version, dataset);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as BenchReport) : undefined;
}
