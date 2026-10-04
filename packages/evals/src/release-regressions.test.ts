import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareBaselines,
  formatRegressions,
  previousVersion,
  releaseRegressions,
} from "./release-regressions.js";

let dir: string;
let reports: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ynm-regress-"));
  reports = join(dir, "reports");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (name: string, data: unknown) =>
  writeFileSync(join(dir, name), `${JSON.stringify(data)}\n`);

function report(version: string, dataset: string, recall: number, accuracy?: number) {
  mkdirSync(join(reports, version), { recursive: true });
  writeFileSync(
    join(reports, version, `${dataset}.json`),
    JSON.stringify({
      setup: { k: 10 },
      retrieval: { evidenceRecallAtK: recall, fullEvidenceAtK: recall },
      ...(accuracy === undefined ? {} : { answering: { n: 20, accuracy } }),
    })
  );
}

describe("previousVersion", () => {
  it("picks the highest released version below the one being frozen", () => {
    for (const v of ["0.1.0", "0.1.1", "0.2.0", "0.10.0"]) put(`${v}.json`, {});
    put("0.2.0.accepted.json", {});
    expect(previousVersion("0.2.0", dir)).toBe("0.1.1");
    expect(previousVersion("0.11.0", dir)).toBe("0.10.0");
    expect(previousVersion("0.1.0", dir)).toBeNull();
    expect(previousVersion("not-a-version", dir)).toBeNull();
    expect(previousVersion("1.0.0", join(dir, "missing"))).toBeNull();
  });
});

describe("compareBaselines", () => {
  it("flags a metric that dropped by more than the tolerance stored with it", () => {
    const rs = compareBaselines(
      { "recall:x@120": { name: "recall:x", size: 120, value: 0.67 } },
      { "recall:x@120": { name: "recall:x", size: 120, value: 0.17, tolerance: 0.05 } }
    );
    expect(rs).toEqual([
      { key: "recall:x@120", previous: 0.67, current: 0.17, rule: "dropped by more than 0.05" },
    ]);
    expect(formatRegressions(rs)).toBe("recall:x@120: 0.67 -> 0.17 (dropped by more than 0.05)");
  });

  it("allows a drop within tolerance, an improvement, and any change to an informational metric", () => {
    expect(
      compareBaselines(
        {
          "a@1": { name: "a", size: 1, value: 0.9 },
          "b@1": { name: "b", size: 1, value: 0.5 },
          "cost@1": { name: "cost", size: 1, value: 0.9 },
        },
        {
          "a@1": { name: "a", size: 1, value: 0.85, tolerance: 0.1 },
          "b@1": { name: "b", size: 1, value: 0.9, tolerance: 0.02 },
          "cost@1": { name: "cost", size: 1, value: 0.01, tolerance: null },
        }
      )
    ).toEqual([]);
  });

  it("uses the previous tolerance, then the recorder's default, when the new entry has none", () => {
    const prev = { "a@1": { name: "a", size: 1, value: 0.9, tolerance: 0.5 } };
    expect(compareBaselines(prev, { "a@1": { name: "a", size: 1, value: 0.5 } })).toEqual([]);
    expect(
      compareBaselines(
        { "a@1": { name: "a", size: 1, value: 0.9 } },
        { "a@1": { name: "a", size: 1, value: 0.85 } }
      )
    ).toHaveLength(1);
  });

  it("flags a timing more than three times slower at p95 and ignores keys only one side has", () => {
    const t = (p95Ms: number) => ({ name: "recall", size: 10, p50Ms: 1, p95Ms, samples: 5 });
    expect(compareBaselines({ "r@10": t(10) }, { "r@10": t(29) })).toEqual([]);
    expect(compareBaselines({ "r@10": t(10) }, { "r@10": t(31) })[0]?.rule).toBe(
      "p95 more than 3x slower"
    );
    expect(compareBaselines({ "old@1": t(1) }, { "new@1": t(100) })).toEqual([]);
  });
});

describe("releaseRegressions", () => {
  it("reports nothing to compare for the first release", () => {
    put("0.1.0.json", { "a@1": { name: "a", size: 1, value: 0.1 } });
    expect(releaseRegressions("0.1.0", dir, reports)).toEqual({
      previousVersion: null,
      regressions: [],
      accepted: [],
      invalidAccepted: [],
    });
  });

  it("fails a regression unless the accepted file explains it, and rejects stale or empty entries", () => {
    put("0.1.1.json", {
      "a@1": { name: "a", size: 1, value: 0.9 },
      "b@1": { name: "b", size: 1, value: 0.9 },
    });
    put("0.2.0.json", {
      "a@1": { name: "a", size: 1, value: 0.1, tolerance: 0.05 },
      "b@1": { name: "b", size: 1, value: 0.1, tolerance: 0.05 },
    });
    expect(releaseRegressions("0.2.0", dir, reports).regressions.map((r) => r.key)).toEqual([
      "a@1",
      "b@1",
    ]);
    put("0.2.0.accepted.json", {
      "a@1": "traded for speed",
      "b@1": "  ",
      "c@1": "no longer drops",
    });
    const r = releaseRegressions("0.2.0", dir, reports);
    expect(r.regressions.map((x) => x.key)).toEqual(["b@1"]);
    expect(r.accepted).toEqual([
      expect.objectContaining({ key: "a@1", reason: "traded for speed" }),
    ]);
    expect(r.invalidAccepted).toEqual(["b@1", "c@1"]);
  });

  it("compares public benchmark retrieval and answering with their own allowances", () => {
    put("0.1.1.json", {});
    put("0.2.0.json", {});
    report("0.1.1", "locomo", 0.57, 0.55);
    report("0.2.0", "locomo", 0.56, 0.45);
    report("0.1.1", "longmemeval-s", 0.91, 0.9);
    report("0.2.0", "longmemeval-s", 0.8, 0.7);
    expect(releaseRegressions("0.2.0", dir, reports).regressions.map((r) => r.key)).toEqual([
      "longmemeval-s:evidence-recall@10",
      "longmemeval-s:full-evidence@10",
      "longmemeval-s:answering-accuracy",
    ]);
  });

  it("skips a dataset or answering that one release did not record", () => {
    put("0.1.1.json", {});
    put("0.2.0.json", {});
    report("0.1.1", "locomo", 0.57);
    report("0.2.0", "locomo", 0.57, 0.1);
    report("0.2.0", "longmemeval-s", 0.1, 0.1);
    expect(releaseRegressions("0.2.0", dir, reports).regressions).toEqual([]);
  });
});
