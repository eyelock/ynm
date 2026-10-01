import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASELINE_DIR,
  BASELINE_FILE,
  baselineFile,
  readBaseline,
  record,
  recordMetric,
  type Timing,
} from "./baseline.js";

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

describe("baseline location", () => {
  it("defaults to the package baselines directory", () => {
    expect(BASELINE_FILE).toBe(baselineFile(BASELINE_DIR));
    expect(BASELINE_DIR.endsWith(join("evals", "baselines"))).toBe(true);
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
