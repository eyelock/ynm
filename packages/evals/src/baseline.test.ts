import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { percentile, REGRESSION_LIMIT, time } from "./baseline.js";
import { RELEASE_VERSION } from "./version.js";

const baselinesDir = join(import.meta.dirname, "..", "baselines");

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

describe("baseline file", () => {
  let tmp: string;
  let file: string;
  let mod: typeof import("./baseline.js");

  // The baseline file sits in the package's baselines/ dir, named by YNM_BASELINE_VERSION; a
  // version that walks out of that dir points the module at a temp file, so committed baselines
  // are never read or written here.
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ynm-baseline-"));
    file = join(tmp, "test.json");
    vi.stubEnv("YNM_BASELINE_VERSION", relative(baselinesDir, join(tmp, "test")));
    vi.stubEnv("YNM_WRITE_BASELINE", "");
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.resetModules();
    mod = await import("./baseline.js");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(tmp, { recursive: true, force: true });
  });

  const timing = (p95Ms: number) => ({ name: "recall", size: 100, p50Ms: 1, p95Ms, samples: 5 });

  it("resolves to the redirected file and reads nothing when it is absent", () => {
    expect(mod.BASELINE_FILE).toBe(file);
    expect(mod.readBaseline()).toEqual({});
  });

  it("names the default file after the release version", async () => {
    vi.stubEnv("YNM_BASELINE_VERSION", undefined);
    vi.resetModules();
    const fresh = await import("./baseline.js");
    expect(fresh.BASELINE_FILE).toBe(join(baselinesDir, `${RELEASE_VERSION}.json`));
  });

  it("compares a timing with the stored p95 without writing", () => {
    writeFileSync(file, JSON.stringify({ "recall@100": timing(2) }));
    const r = mod.record(timing(7));
    expect(r.baseline).toEqual(timing(2));
    expect(r.ratio).toBe(3.5);
    expect(r.ratio).toBeGreaterThan(mod.REGRESSION_LIMIT);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "recall@100": timing(2) });
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("baseline p95 2ms, x3.50"));
  });

  it("guards the ratio against a zero baseline", () => {
    writeFileSync(file, JSON.stringify({ "recall@100": timing(0) }));
    expect(mod.record(timing(1)).ratio).toBe(100);
  });

  it("reports no baseline and no ratio for an unseen timing", () => {
    expect(mod.record(timing(3))).toEqual({ baseline: undefined, ratio: undefined });
    expect(existsSync(file)).toBe(false);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("(no baseline)"));
  });

  it("writes timings with YNM_WRITE_BASELINE=1 and never reports a regression then", () => {
    vi.stubEnv("YNM_WRITE_BASELINE", "1");
    writeFileSync(file, JSON.stringify({ "other@1": timing(9) }));
    const r = mod.record(timing(4));
    expect(r.ratio).toBeUndefined();
    const all = JSON.parse(readFileSync(file, "utf8"));
    expect(all).toEqual({ "other@1": timing(9), "recall@100": timing(4) });
    expect(readFileSync(file, "utf8").endsWith("}\n")).toBe(true);
    // Replacing an existing entry still yields no ratio.
    expect(mod.record(timing(40)).ratio).toBeUndefined();
    expect(mod.readBaseline()["recall@100"]).toEqual(timing(40));
  });

  it("flags a metric that drops by more than the tolerance", () => {
    writeFileSync(file, JSON.stringify({ "mrr@50": { name: "mrr", size: 50, value: 0.8 } }));
    const ok = mod.recordMetric({ name: "mrr", size: 50, value: 0.79 });
    expect(ok).toEqual({ baseline: { name: "mrr", size: 50, value: 0.8 }, regressed: false });
    expect(mod.recordMetric({ name: "mrr", size: 50, value: 0.7 }).regressed).toBe(true);
    expect(mod.recordMetric({ name: "mrr", size: 50, value: 0.7 }, 0.2).regressed).toBe(false);
    expect(mod.recordMetric({ name: "mrr", size: 50, value: 0.95 }).regressed).toBe(false);
    expect(console.info).toHaveBeenCalledWith("metric mrr@50: 0.7900 (baseline 0.8000)");
  });

  it("reports no baseline for an unseen metric", () => {
    expect(mod.recordMetric({ name: "ndcg", size: 10, value: 0.5 })).toEqual({
      baseline: undefined,
      regressed: false,
    });
    expect(console.info).toHaveBeenCalledWith("metric ndcg@10: 0.5000 (no baseline)");
    expect(existsSync(file)).toBe(false);
  });

  it("writes metrics with YNM_WRITE_BASELINE=1 and never flags a regression then", () => {
    vi.stubEnv("YNM_WRITE_BASELINE", "1");
    writeFileSync(file, JSON.stringify({ "mrr@50": { name: "mrr", size: 50, value: 0.9 } }));
    const r = mod.recordMetric({ name: "mrr", size: 50, value: 0.1 });
    expect(r.regressed).toBe(false);
    expect(r.baseline).toEqual({ name: "mrr", size: 50, value: 0.9 });
    expect(mod.readBaseline()["mrr@50"]).toEqual({ name: "mrr", size: 50, value: 0.1 });
  });
});
