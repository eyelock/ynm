import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  benchDir,
  DATASET_FILES,
  datasetPath,
  LOCOMO_CATEGORIES,
  loadLocomo,
  loadLongMemEval,
  parseLocomoDate,
  parseLongMemEvalDate,
  sampleCases,
} from "./datasets.js";

const fixtures = join(import.meta.dirname, "..", "..", "test", "fixtures", "tier3");

describe("tier3 dataset adapters", () => {
  it("parses both benchmarks' date formats to ISO", () => {
    expect(parseLocomoDate("1:56 pm on 8 May, 2023")).toBe("2023-05-08T13:56:00.000Z");
    expect(parseLocomoDate("12:05 am on 21 January 2024")).toBe("2024-01-21T00:05:00.000Z");
    expect(parseLocomoDate("12:30 pm on 1 March, 2022")).toBe("2022-03-01T12:30:00.000Z");
    expect(parseLongMemEvalDate("2023/05/20 (Sat) 02:21")).toBe("2023-05-20T02:21:00.000Z");
    expect(() => parseLocomoDate("yesterday")).toThrow(/unparseable/);
  });
  it("rejects an unknown LoCoMo month and a malformed LongMemEval date", () => {
    expect(() => parseLocomoDate("1:56 pm on 8 Smarch, 2023")).toThrow(/unparseable LoCoMo month/);
    expect(() => parseLongMemEvalDate("2023-05-20 02:21")).toThrow(/unparseable LongMemEval date/);
  });
  it("samples deterministically", () => {
    const cases = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      sessions: [],
      questions: [],
    }));
    const a = sampleCases(cases, 5, 7).map((c) => c.id);
    const b = sampleCases(cases, 5, 7).map((c) => c.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(5);
    expect(sampleCases(cases, 5, 8).map((c) => c.id)).not.toEqual(a);
    expect(sampleCases(cases, 50)).toHaveLength(20);
    expect(sampleCases(cases, undefined)).toBe(cases);
    expect(LOCOMO_CATEGORIES[5]).toBe("adversarial");
  });
});

describe("tier3 dataset locations", () => {
  it("caches under ~/.ynm/bench unless YNM_BENCH_DIR says otherwise", () => {
    expect(benchDir({})).toBe(join(homedir(), ".ynm", "bench"));
    expect(benchDir({ YNM_BENCH_DIR: "/data/bench" })).toBe("/data/bench");
    expect(datasetPath("locomo", { YNM_BENCH_DIR: "/data/bench" })).toBe(
      join("/data/bench", DATASET_FILES.locomo.file)
    );
    expect(datasetPath("longmemeval-s", { YNM_BENCH_DIR: "/data/bench" })).toBe(
      join("/data/bench", DATASET_FILES["longmemeval-s"].file)
    );
  });
  it("names the download source when a dataset file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ynm-bench-"));
    try {
      expect(() => loadLocomo(join(dir, "absent.json"))).toThrow(DATASET_FILES.locomo.source);
      expect(() => loadLongMemEval(join(dir, "absent.json"))).toThrow(
        DATASET_FILES["longmemeval-s"].source
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tier3 LoCoMo loader", () => {
  const ds = loadLocomo(join(fixtures, "locomo-mini.json"));

  it("describes the dataset with its source, license and content hash", () => {
    expect(ds.name).toBe("locomo");
    expect(ds.file).toBe(join(fixtures, "locomo-mini.json"));
    expect(ds.source).toBe(DATASET_FILES.locomo.source);
    expect(ds.license).toBe("CC BY-NC 4.0");
    expect(ds.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ds.cases.map((c) => c.id)).toEqual(["conv-a", "conv-b"]);
  });
  it("orders sessions numerically, dates them, and folds image captions into the text", () => {
    const [a] = ds.cases;
    expect(a?.sessions.map((s) => s.id)).toEqual(["session_1", "session_2"]);
    expect(a?.sessions.map((s) => s.date)).toEqual([
      "2023-05-08T13:56:00.000Z",
      "2023-06-20T09:15:00.000Z",
    ]);
    expect(a?.sessions[0]?.turns[0]).toEqual({
      id: "D1:1",
      speaker: "Ada",
      text: "I adopted a greyhound named Pickles last week.",
    });
    expect(a?.sessions[1]?.turns[1]?.text).toBe(
      "Here is my new kayak. [shared an image: a red kayak on a lake]"
    );
  });
  it("maps questions: ids, categories, string answers, evidence and abstention", () => {
    const qs = ds.cases[0]?.questions ?? [];
    expect(qs.map((q) => q.id)).toEqual([
      "conv-a:q0",
      "conv-a:q1",
      "conv-a:q2",
      "conv-a:q3",
      "conv-a:q4",
    ]);
    expect(qs.map((q) => q.category)).toEqual([
      "single-hop",
      "temporal",
      "multi-hop",
      "adversarial",
      "9",
    ]);
    expect(qs[0]).toMatchObject({ answer: "Pickles", evidence: ["D1:1"], evidenceKind: "turn" });
    expect(qs[0]?.abstain).toBe(false);
    expect(qs[0]?.date).toBeUndefined();
    // Adversarial questions have no answer; the adversarial one stands in and abstaining is right.
    expect(qs[3]).toMatchObject({ answer: "a telescope", abstain: true, evidence: [] });
    // Numeric answers are stringified and a missing evidence list becomes empty.
    expect(qs[4]).toMatchObject({ answer: "2023", evidence: [], abstain: false });
  });
  it("hashes the file content, so a different file gets a different sha", () => {
    const dir = mkdtempSync(join(tmpdir(), "ynm-bench-"));
    try {
      const file = join(dir, "locomo.json");
      writeFileSync(
        file,
        JSON.stringify([
          {
            sample_id: "solo",
            conversation: { speaker_a: "A", speaker_b: "B" },
            qa: [{ question: "Anything?", category: 3 }],
          },
        ])
      );
      const solo = loadLocomo(file);
      expect(solo.sha256).not.toBe(ds.sha256);
      expect(solo.cases[0]?.sessions).toEqual([]);
      expect(solo.cases[0]?.questions[0]).toMatchObject({ answer: "", category: "open-domain" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tier3 LongMemEval-S loader", () => {
  const ds = loadLongMemEval(join(fixtures, "longmemeval-mini.json"));

  it("describes the dataset and makes one case per instance", () => {
    expect(ds.name).toBe("longmemeval-s");
    expect(ds.source).toBe(DATASET_FILES["longmemeval-s"].source);
    expect(ds.license).toBe("MIT");
    expect(ds.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ds.cases.map((c) => c.id)).toEqual(["q-orchid", "q-bikes_abs"]);
    expect(ds.cases.every((c) => c.questions.length === 1)).toBe(true);
  });
  it("turns haystack sessions into dated sessions with positional turn ids", () => {
    const c = ds.cases[0];
    expect(c?.sessions.map((s) => [s.id, s.date])).toEqual([
      ["s-orchid", "2023-05-20T02:21:00.000Z"],
      ["s-weather", "2023-05-22T18:45:00.000Z"],
    ]);
    expect(c?.sessions[0]?.turns).toEqual([
      {
        id: "s-orchid:0",
        speaker: "user",
        text: "I bought a purple orchid for the kitchen window.",
      },
      { id: "s-orchid:1", speaker: "assistant", text: "Orchids like bright indirect light." },
    ]);
  });
  it("keeps session evidence and the question date for an answerable question", () => {
    expect(ds.cases[0]?.questions[0]).toEqual({
      id: "q-orchid",
      question: "What colour orchid did I buy?",
      answer: "purple",
      category: "single-session-user",
      evidence: ["s-orchid"],
      evidenceKind: "session",
      date: "2023-05-30T10:00:00.000Z",
      abstain: false,
    });
  });
  it("treats an _abs instance as abstention with no evidence", () => {
    expect(ds.cases[1]?.questions[0]).toMatchObject({
      answer: "3",
      category: "abstention",
      evidence: [],
      abstain: true,
      date: "2023-06-01T09:30:00.000Z",
    });
  });
});
