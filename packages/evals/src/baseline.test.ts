import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASELINE_DIR,
  BASELINE_FILE,
  baselineFile,
  percentile,
  REGRESSION_LIMIT,
  readBaseline,
  record,
  recordMetric,
  type Timing,
  time,
} from "./baseline.js";
import { RELEASE_VERSION } from "./version.js";

const timing: Timing = { name: "recall", size: 10, p50Ms: 1, p95Ms: 2, samples: 5 };

let dir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ynm-baseline-"));
  logs = [];
  vi.spyOn(console, "info").mockImplementation((line: string) => void logs.push(line));
  vi.stubEnv("YNM_WRITE_BASELINE", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const seed = (entries: Record<string, unknown>) =>
  writeFileSync(baselineFile(dir), `${JSON.stringify(entries)}\n`);

describe("baseline percentiles and timing", () => {
  it("picks the nearest-rank percentile without mutating the input", () => {
    const values = [5, 1, 4, 2, 3];
    expect(percentile(values, 50)).toBe(3);
    expect(percentile(values, 95)).toBe(5);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 100)).toBe(5);
    expect(values).toEqual([5, 1, 4, 2, 3]);
    expect(percentile([], 50)).toBe(0);
  });

  it("times a function for the requested samples and rounds to hundredths", async () => {
    let calls = 0;
    const t = await time("noop", 7, 4, async () => {
      calls += 1;
    });
    expect(calls).toBe(4);
    expect(t).toMatchObject({ name: "noop", size: 7, samples: 4 });
    expect(t.p95Ms).toBeGreaterThanOrEqual(t.p50Ms);
    expect(Math.round(t.p50Ms * 100) / 100).toBe(t.p50Ms);
    expect(REGRESSION_LIMIT).toBe(3);
  });
});

describe("baseline location", () => {
  it("defaults to the package baselines directory, named after the release version", () => {
    expect(BASELINE_FILE).toBe(baselineFile(BASELINE_DIR));
    expect(BASELINE_DIR.endsWith(join("evals", "baselines"))).toBe(true);
    expect(baselineFile(BASELINE_DIR)).toBe(join(BASELINE_DIR, `${RELEASE_VERSION}.json`));
  });

  it("reads nothing when the file is absent", () => {
    expect(readBaseline({ dir })).toEqual({});
  });

  it("reads and writes an injected directory", () => {
    vi.stubEnv("YNM_WRITE_BASELINE", "1");
    record(timing, { dir });
    recordMetric({ name: "mrr", size: 10, value: 0.5 }, 0.02, { dir });
    expect(readBaseline({ dir })).toEqual({
      "recall@10": timing,
      "mrr@10": { name: "mrr", size: 10, value: 0.5 },
    });
  });
});

describe("record", () => {
  const at = (p95Ms: number): Timing => ({ ...timing, p95Ms });

  it("compares with the stored p95 without writing", () => {
    seed({ "recall@10": at(2) });
    const r = record(at(7), { dir });
    expect(r.baseline).toEqual(at(2));
    expect(r.ratio).toBe(3.5);
    expect(r.ratio).toBeGreaterThan(REGRESSION_LIMIT);
    expect(readBaseline({ dir })).toEqual({ "recall@10": at(2) });
  });

  it("guards the ratio against a zero baseline", () => {
    seed({ "recall@10": at(0) });
    expect(record(at(1), { dir }).ratio).toBe(100);
  });

  it("reports no baseline and no ratio for an unseen timing", () => {
    expect(record(timing, { dir })).toEqual({ baseline: undefined, ratio: undefined });
    expect(existsSync(baselineFile(dir))).toBe(false);
    expect(logs.join("\n")).toContain("(no baseline)");
  });

  it("writes with YNM_WRITE_BASELINE=1, keeps other entries, ends with a newline", () => {
    seed({ "other@1": at(9) });
    vi.stubEnv("YNM_WRITE_BASELINE", "1");
    expect(record(at(4), { dir }).ratio).toBeUndefined();
    expect(readBaseline({ dir })).toEqual({ "other@1": at(9), "recall@10": at(4) });
    expect(readFileSync(baselineFile(dir), "utf8").endsWith("}\n")).toBe(true);
  });

  it("logs no ratio while rewriting an existing baseline", () => {
    seed({ "recall@10": { ...timing, p95Ms: 4 } });
    vi.stubEnv("YNM_WRITE_BASELINE", "1");
    const r = record(timing, { dir });
    expect(r.ratio).toBeUndefined();
    expect(logs.join("\n")).not.toContain("undefined");
    expect(logs.join("\n")).toContain("baseline p95 4ms");
  });

  it("logs the ratio when comparing", () => {
    seed({ "recall@10": { ...timing, p95Ms: 1 } });
    const r = record(timing, { dir });
    expect(r.ratio).toBe(2);
    expect(logs.join("\n")).toContain("(baseline p95 1ms, x2.00)");
  });

  it("rejects a metric entry stored under a timing key", () => {
    const before = { "recall@10": { name: "recall", size: 10, value: 0.9 } };
    seed(before);
    expect(() => record(timing, { dir })).toThrow(/recall@10.*metric/);
    vi.stubEnv("YNM_WRITE_BASELINE", "1");
    expect(() => record(timing, { dir })).toThrow(/recall@10/);
    expect(readBaseline({ dir })).toEqual(before);
  });
});

describe("recordMetric", () => {
  it("compares within tolerance and logs both values", () => {
    seed({ "mrr@50": { name: "mrr", size: 50, value: 0.8 } });
    expect(recordMetric({ name: "mrr", size: 50, value: 0.79 }, 0.02, { dir })).toEqual({
      baseline: { name: "mrr", size: 50, value: 0.8 },
      regressed: false,
    });
    expect(recordMetric({ name: "mrr", size: 50, value: 0.7 }, 0.2, { dir }).regressed).toBe(false);
    expect(recordMetric({ name: "mrr", size: 50, value: 0.95 }, 0.02, { dir }).regressed).toBe(
      false
    );
    expect(logs).toContain("metric mrr@50: 0.7900 (baseline 0.8000)");
  });

  it("reports no baseline for an unseen metric and writes nothing", () => {
    expect(recordMetric({ name: "ndcg", size: 10, value: 0.5 }, 0.02, { dir })).toEqual({
      baseline: undefined,
      regressed: false,
    });
    expect(logs).toContain("metric ndcg@10: 0.5000 (no baseline)");
    expect(existsSync(baselineFile(dir))).toBe(false);
  });

  it("writes with YNM_WRITE_BASELINE=1 and never flags a regression then", () => {
    seed({ "mrr@50": { name: "mrr", size: 50, value: 0.9 } });
    vi.stubEnv("YNM_WRITE_BASELINE", "1");
    const r = recordMetric({ name: "mrr", size: 50, value: 0.1 }, 0.02, { dir });
    expect(r).toEqual({ baseline: { name: "mrr", size: 50, value: 0.9 }, regressed: false });
    expect(readBaseline({ dir })["mrr@50"]).toEqual({ name: "mrr", size: 50, value: 0.1 });
  });

  it("flags a drop beyond tolerance", () => {
    seed({ "mrr@10": { name: "mrr", size: 10, value: 0.9 } });
    expect(recordMetric({ name: "mrr", size: 10, value: 0.8 }, 0.02, { dir }).regressed).toBe(true);
    expect(recordMetric({ name: "mrr", size: 10, value: 0.89 }, 0.02, { dir }).regressed).toBe(
      false
    );
  });

  it("rejects a timing entry stored under a metric key instead of crashing or passing", () => {
    seed({ "recall@10": timing });
    expect(() => recordMetric({ name: "recall", size: 10, value: 0.5 }, 0.02, { dir })).toThrow(
      /recall@10.*timing/
    );
  });

  it("does not overwrite a timing entry when writing the baseline", () => {
    seed({ "recall@10": timing });
    vi.stubEnv("YNM_WRITE_BASELINE", "1");
    expect(() => recordMetric({ name: "recall", size: 10, value: 0.5 }, 0.02, { dir })).toThrow(
      /recall@10/
    );
    expect(readBaseline({ dir })).toEqual({ "recall@10": timing });
  });

  it("never touches the default baseline file when a directory is injected", () => {
    const before = existsSync(BASELINE_FILE) ? readFileSync(BASELINE_FILE, "utf8") : undefined;
    vi.stubEnv("YNM_WRITE_BASELINE", "1");
    recordMetric({ name: "probe", size: 1, value: 1 }, 0.02, { dir });
    const after = existsSync(BASELINE_FILE) ? readFileSync(BASELINE_FILE, "utf8") : undefined;
    expect(after).toBe(before);
  });
});
