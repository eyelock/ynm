import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_VERSION } from "./version.js";

export interface Timing {
  name: string;
  size: number;
  p50Ms: number;
  p95Ms: number;
  samples: number;
}

/** Where real gate and bench runs keep baselines: packages/evals/baselines. */
export const BASELINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "baselines");

/** The baseline file for the current version inside `dir`. */
export function baselineFile(dir = BASELINE_DIR): string {
  return join(dir, `${process.env.YNM_BASELINE_VERSION ?? RELEASE_VERSION}.json`);
}

export const BASELINE_FILE = baselineFile();

/** Options shared by the baseline functions; `dir` defaults to {@link BASELINE_DIR}. */
export interface BaselineOptions {
  dir?: string;
}

/**
 * Timings and metrics share one `name@size` keyspace. An entry of the other kind under a key is a
 * name collision between suites, so it fails loudly rather than being compared (NaN passes every
 * check) or silently overwritten.
 */
function entryOfKind<K extends "timing" | "metric">(
  all: Record<string, Timing | Metric>,
  key: string,
  kind: K,
  file: string
): (K extends "timing" ? Timing : Metric) | undefined {
  const entry = all[key];
  if (entry === undefined) return undefined;
  const found = "value" in entry ? "metric" : "p95Ms" in entry ? "timing" : "unknown";
  if (found !== kind) {
    throw new Error(
      `baseline key ${key} holds a ${found} entry, not a ${kind}; rename one of the two so their name@size keys differ (${file})`
    );
  }
  return entry as K extends "timing" ? Timing : Metric;
}

function writeBaseline(dir: string, all: Record<string, Timing | Metric>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(baselineFile(dir), `${JSON.stringify(all, null, 2)}\n`);
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

export async function time(
  name: string,
  size: number,
  samples: number,
  fn: () => Promise<void>
): Promise<Timing> {
  const ms: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    await fn();
    ms.push(performance.now() - t0);
  }
  return {
    name,
    size,
    p50Ms: Math.round(percentile(ms, 50) * 100) / 100,
    p95Ms: Math.round(percentile(ms, 95) * 100) / 100,
    samples,
  };
}

export function readBaseline(opts: BaselineOptions = {}): Record<string, Timing> {
  const file = baselineFile(opts.dir);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Timing>) : {};
}

/**
 * Records a timing. With YNM_WRITE_BASELINE=1 the baseline file is updated; otherwise the timing
 * is compared with the stored one and a gross regression (over 3x p95) fails (ADR-014: relative
 * regression gating; absolute budgets are reported, not gated).
 */
export function record(
  t: Timing,
  opts: BaselineOptions = {}
): { baseline?: Timing; ratio?: number } {
  const key = `${t.name}@${t.size}`;
  const all = readBaseline(opts) as Record<string, Timing | Metric>;
  const baseline = entryOfKind(all, key, "timing", baselineFile(opts.dir));
  if (process.env.YNM_WRITE_BASELINE === "1") {
    all[key] = { ...t, p50Ms: t.p50Ms, p95Ms: t.p95Ms };
    writeBaseline(opts.dir ?? BASELINE_DIR, all);
  }
  // While establishing a baseline the old numbers are being replaced, so nothing can "regress".
  const ratio =
    baseline && process.env.YNM_WRITE_BASELINE !== "1"
      ? t.p95Ms / Math.max(baseline.p95Ms, 0.01)
      : undefined;
  const vs = ratio === undefined ? "" : `, x${ratio.toFixed(2)}`;
  console.info(
    `bench ${key}: p50 ${t.p50Ms}ms p95 ${t.p95Ms}ms${baseline ? ` (baseline p95 ${baseline.p95Ms}ms${vs})` : " (no baseline)"}`
  );
  return { baseline, ratio };
}

export const REGRESSION_LIMIT = 3;

export interface Metric {
  name: string;
  size: number;
  value: number;
  /**
   * The drop the suite allows, stored with the value so the release gate compares releases with
   * the same allowance; `null` marks an informational metric (cost, seconds) that never gates.
   */
  tolerance?: number | null;
}

/** Records a quality metric (higher is better); a drop of more than `tolerance` vs baseline fails. */
export function recordMetric(
  m: Metric,
  tolerance = 0.02,
  opts: BaselineOptions = {}
): { baseline?: Metric; regressed: boolean } {
  const key = `${m.name}@${m.size}`;
  const all = readBaseline(opts) as Record<string, Timing | Metric>;
  const baseline = entryOfKind(all, key, "metric", baselineFile(opts.dir));
  if (process.env.YNM_WRITE_BASELINE === "1") {
    all[key] = { ...m, tolerance: Number.isFinite(tolerance) ? tolerance : null };
    writeBaseline(opts.dir ?? BASELINE_DIR, all);
  }
  const regressed =
    !!baseline && process.env.YNM_WRITE_BASELINE !== "1" && baseline.value - m.value > tolerance;
  console.info(
    `metric ${key}: ${m.value.toFixed(4)}${baseline ? ` (baseline ${baseline.value.toFixed(4)})` : " (no baseline)"}`
  );
  return { baseline, regressed };
}
