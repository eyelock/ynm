import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Timing {
  name: string;
  size: number;
  p50Ms: number;
  p95Ms: number;
  samples: number;
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "baselines");
export const BASELINE_FILE = join(dir, `${process.env.YNM_BASELINE_VERSION ?? "0.1.0"}.json`);

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

export function readBaseline(): Record<string, Timing> {
  return existsSync(BASELINE_FILE)
    ? (JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Record<string, Timing>)
    : {};
}

/**
 * Records a timing. With YNM_WRITE_BASELINE=1 the baseline file is updated; otherwise the timing
 * is compared with the stored one and a gross regression (over 3x p95) fails (ADR-014: relative
 * regression gating; absolute budgets are reported, not gated).
 */
export function record(t: Timing): { baseline?: Timing; ratio?: number } {
  const key = `${t.name}@${t.size}`;
  const all = readBaseline();
  const baseline = all[key];
  if (process.env.YNM_WRITE_BASELINE === "1") {
    all[key] = { ...t, p50Ms: t.p50Ms, p95Ms: t.p95Ms };
    mkdirSync(dir, { recursive: true });
    writeFileSync(BASELINE_FILE, `${JSON.stringify(all, null, 2)}\n`);
  }
  // While establishing a baseline the old numbers are being replaced, so nothing can "regress".
  const ratio =
    baseline && process.env.YNM_WRITE_BASELINE !== "1"
      ? t.p95Ms / Math.max(baseline.p95Ms, 0.01)
      : undefined;
  console.info(
    `bench ${key}: p50 ${t.p50Ms}ms p95 ${t.p95Ms}ms${baseline ? ` (baseline p95 ${baseline.p95Ms}ms, x${ratio?.toFixed(2)})` : " (no baseline)"}`
  );
  return { baseline, ratio };
}

export const REGRESSION_LIMIT = 3;

export interface Metric {
  name: string;
  size: number;
  value: number;
}

/** Records a quality metric (higher is better); a drop of more than `tolerance` vs baseline fails. */
export function recordMetric(
  m: Metric,
  tolerance = 0.02
): { baseline?: Metric; regressed: boolean } {
  const key = `${m.name}@${m.size}`;
  const all = readBaseline() as Record<string, Timing | Metric>;
  const baseline = all[key] as Metric | undefined;
  if (process.env.YNM_WRITE_BASELINE === "1") {
    all[key] = m;
    mkdirSync(dir, { recursive: true });
    writeFileSync(BASELINE_FILE, `${JSON.stringify(all, null, 2)}\n`);
  }
  const regressed =
    !!baseline && process.env.YNM_WRITE_BASELINE !== "1" && baseline.value - m.value > tolerance;
  console.info(
    `metric ${key}: ${m.value.toFixed(4)}${baseline ? ` (baseline ${baseline.value.toFixed(4)})` : " (no baseline)"}`
  );
  return { baseline: baseline && "value" in baseline ? baseline : undefined, regressed };
}
