import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_DIR, type Metric, REGRESSION_LIMIT, type Timing } from "./baseline.js";
import type { BenchReport } from "./tier3/driver.js";
import { REPORTS_DIR, readReport } from "./tier3/report.js";

/**
 * The release gate's regression check (ADR-014). Each release freezes its own baseline file, and
 * a suite run with YNM_WRITE_BASELINE=1 compares with nothing, so a regression recorded while
 * freezing a new version would otherwise pass. This compares the new version's frozen baseline
 * with the previous release's, key by key, using the allowance the suite itself uses.
 */

/** Allowance for a metric written before tolerances were stored (the recorder's default). */
export const DEFAULT_TOLERANCE = 0.02;

/** The public benchmark datasets whose committed reports are compared release to release. */
export const REPORT_DATASETS = ["locomo", "longmemeval-s"] as const;

/**
 * Allowances for the public benchmark reports. Retrieval is deterministic for a dataset; answering
 * is a 20-question sample judged by a model, so three questions' worth of noise is allowed.
 */
export const REPORT_TOLERANCE = { retrieval: 0.02, answering: 0.15 } as const;

type Entry = Timing | Metric;
type Baseline = Record<string, Entry>;

export interface Regression {
  key: string;
  previous: number | string;
  current: number | string;
  /** Human-readable rule that was broken. */
  rule: string;
}

export interface RegressionReport {
  previousVersion: string | null;
  regressions: Regression[];
  /** Regressions listed in `<version>.accepted.json`, with the reason given there. */
  accepted: Array<Regression & { reason: string }>;
  /** Keys in the accepted file that have no reason, or that no longer regress. */
  invalidAccepted: string[];
}

function parseVersion(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++)
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) - (b[i] as number);
  return 0;
}

/** The highest released version below `version` that has a frozen baseline in `dir`. */
export function previousVersion(version: string, dir = BASELINE_DIR): string | null {
  const target = parseVersion(version);
  if (!target || !existsSync(dir)) return null;
  const older = readdirSync(dir)
    .map((f) => /^(\d+\.\d+\.\d+)\.json$/.exec(f)?.[1])
    .filter((v): v is string => !!v)
    .map((v) => ({ v, n: parseVersion(v) as number[] }))
    .filter(({ n }) => compareVersions(n, target) < 0)
    .sort((a, b) => compareVersions(b.n, a.n));
  return older[0]?.v ?? null;
}

function readJson<T>(file: string): T | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
}

function isMetric(e: Entry): e is Metric {
  return "value" in e;
}

/** Every key present in both baselines whose value got worse than its allowance permits. */
export function compareBaselines(previous: Baseline, current: Baseline): Regression[] {
  const out: Regression[] = [];
  for (const [key, cur] of Object.entries(current)) {
    const prev = previous[key];
    if (!prev) continue;
    if (isMetric(cur) && isMetric(prev)) {
      // The current suite's allowance wins; null on either side marks an informational metric.
      const tol = cur.tolerance !== undefined ? cur.tolerance : prev.tolerance;
      if (tol === null) continue;
      const allowed = tol ?? DEFAULT_TOLERANCE;
      if (prev.value - cur.value > allowed)
        out.push({
          key,
          previous: prev.value,
          current: cur.value,
          rule: `dropped by more than ${allowed}`,
        });
    } else if (!isMetric(cur) && !isMetric(prev)) {
      if (cur.p95Ms > Math.max(prev.p95Ms, 0.01) * REGRESSION_LIMIT)
        out.push({
          key,
          previous: prev.p95Ms,
          current: cur.p95Ms,
          rule: `p95 more than ${REGRESSION_LIMIT}x slower`,
        });
    }
  }
  return out;
}

/**
 * What makes two reports comparable: the dataset and how it was run. Cases and questions are the
 * sample (LongMemEval-S went from 500 cases to 60 between releases), k and index how retrieval was
 * scored; the answering sample size and its writer and judge matter only when both reports answered.
 */
function setupDifferences(a: BenchReport, b: BenchReport): string[] {
  const diffs: string[] = [];
  const same = (name: string, x: unknown, y: unknown) => {
    if (x !== y) diffs.push(`${name} ${String(x)} -> ${String(y)}`);
  };
  same("dataset", a.datasetSha256, b.datasetSha256);
  same("cases", a.setup.cases, b.setup.cases);
  same("questions", a.setup.questions, b.setup.questions);
  same("k", a.setup.k, b.setup.k);
  same("index", a.setup.index, b.setup.index);
  if (a.answering && b.answering) {
    same("answered", a.answering.n, b.answering.n);
    same("writer", a.setup.writer, b.setup.writer);
    same("judge", a.setup.judge, b.setup.judge);
  }
  return diffs;
}

/**
 * Retrieval and answering in `version`'s public benchmark reports that fell below `previous`'s. A
 * dataset whose two reports were not run the same way is not compared number to number: it is one
 * regression, keyed `<dataset>:setup`, until the runs match or the difference is accepted.
 */
export function compareReports(previous: string, version: string, dir = REPORTS_DIR): Regression[] {
  const out: Regression[] = [];
  const check = (key: string, prev: number | undefined, cur: number | undefined, tol: number) => {
    if (prev === undefined || cur === undefined) return;
    if (prev - cur > tol)
      out.push({ key, previous: prev, current: cur, rule: `dropped by more than ${tol}` });
  };
  for (const name of REPORT_DATASETS) {
    const a = readReport(previous, name, { dir });
    const b = readReport(version, name, { dir });
    if (!a || !b) continue;
    const differences = setupDifferences(a, b);
    if (differences.length) {
      out.push({
        key: `${name}:setup`,
        previous: previous,
        current: version,
        rule: `not comparable, the runs differ (${differences.join("; ")}); run both the same way, or accept it with a reason`,
      });
      continue;
    }
    const k = b.setup.k;
    check(
      `${name}:evidence-recall@${k}`,
      a.retrieval.evidenceRecallAtK,
      b.retrieval.evidenceRecallAtK,
      REPORT_TOLERANCE.retrieval
    );
    check(
      `${name}:full-evidence@${k}`,
      a.retrieval.fullEvidenceAtK,
      b.retrieval.fullEvidenceAtK,
      REPORT_TOLERANCE.retrieval
    );
    check(
      `${name}:answering-accuracy`,
      a.answering?.accuracy,
      b.answering?.accuracy,
      REPORT_TOLERANCE.answering
    );
  }
  return out;
}

/**
 * Compares `version`'s frozen baseline and public benchmark reports with the previous release's. A regression is allowed only
 * when `<version>.accepted.json` in `dir` names its key with a non-empty reason, so trading one
 * metric for another is a recorded decision, never an accident.
 */
export function releaseRegressions(
  version: string,
  dir = BASELINE_DIR,
  reportsDir = REPORTS_DIR
): RegressionReport {
  const prevVersion = previousVersion(version, dir);
  const current = readJson<Baseline>(join(dir, `${version}.json`)) ?? {};
  const previous = prevVersion ? (readJson<Baseline>(join(dir, `${prevVersion}.json`)) ?? {}) : {};
  const acceptedFile =
    readJson<Record<string, unknown>>(join(dir, `${version}.accepted.json`)) ?? {};
  const found = [
    ...compareBaselines(previous, current),
    ...(prevVersion ? compareReports(prevVersion, version, reportsDir) : []),
  ];
  const reasonFor = (key: string) => {
    const r = acceptedFile[key];
    return typeof r === "string" && r.trim() ? r.trim() : null;
  };
  const regressions = found.filter((r) => !reasonFor(r.key));
  const accepted = found
    .filter((r) => reasonFor(r.key))
    .map((r) => ({ ...r, reason: reasonFor(r.key) as string }));
  const regressed = new Set(found.map((r) => r.key));
  const invalidAccepted = Object.keys(acceptedFile).filter(
    (k) => !reasonFor(k) || !regressed.has(k)
  );
  return { previousVersion: prevVersion, regressions, accepted, invalidAccepted };
}

/** One line per regression, for gate failure messages. */
export function formatRegressions(rs: Regression[]): string {
  return rs.map((r) => `${r.key}: ${r.previous} -> ${r.current} (${r.rule})`).join("\n");
}
