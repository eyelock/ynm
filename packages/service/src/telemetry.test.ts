import { DreamConfigSchema } from "@ynm/model";
import { HeuristicJudge, NoneWriter } from "@ynm/models";
import { MemoryLog, type RecordLog } from "@ynm/store";
import { makeRecord } from "@ynm/store/testing";
import { type MemoryTelemetry, startMemoryTelemetry } from "@ynm/telemetry/testing";
import { DEFAULT_REDACTION } from "./config.js";
import { dream } from "./dream/engine.js";
import { IndexManager } from "./indexing.js";
import { instrumentLog } from "./telemetry.js";
import { Ynm } from "./ynm.js";

let telemetry: MemoryTelemetry | undefined;
afterEach(async () => {
  await telemetry?.stop();
  telemetry = undefined;
});

describe("instrumentLog", () => {
  it("returns the log itself when telemetry is off", () => {
    const log = new MemoryLog("m", "personal");
    expect(instrumentLog(log)).toBe(log);
  });

  it("spans appends, scans, purges and documents with counts, passing results through", async () => {
    telemetry = await startMemoryTelemetry();
    const inner = new MemoryLog("team", "personal");
    const log = instrumentLog(inner);
    expect(log).not.toBe(inner);
    expect([log.id, log.level, log.provider]).toEqual(["team", "personal", "memory"]);
    const a = makeRecord({ content: "secret body", level: "personal", namespace: "user/alice" });
    const b = makeRecord({ content: "another", level: "personal", namespace: "user/alice" });
    expect((await log.append([a, b])).appended).toBe(2);
    const all: string[] = [];
    for await (const r of log.scan({ namespace: "user/alice" })) all.push(r.id);
    expect(all.sort()).toEqual([a.id, b.id].sort());
    // A consumer that stops early ends the scan's span with what it read.
    for await (const _ of log.scan()) break;
    expect((await log.purge(a.memoryId)).removed).toBe(1);
    expect(await log.writeDocument?.("people", "{}", null)).toBeTruthy();
    expect((await log.readDocument?.("people"))?.text).toBe("{}");
    expect((await log.shards()).length).toBeGreaterThan(0);

    const { spans, logs, text } = await telemetry.exported();
    const names = spans.map((s) => s.name);
    expect(names).toEqual([
      "store append",
      "store scan",
      "store scan",
      "store purge",
      "store write_document",
      "store read_document",
    ]);
    expect(spans.map((s) => s.attributes["ynm.record.count"])).toEqual([
      2,
      2,
      1,
      1,
      undefined,
      undefined,
    ]);
    expect(spans[0]?.attributes).toMatchObject({
      "ynm.store.operation": "append",
      "ynm.store.provider": "memory",
      "ynm.mount": "team",
      "ynm.level": "personal",
      "ynm.outcome": "ok",
    });
    expect(logs.filter((l) => l.eventName === "ynm.store.started")).toHaveLength(6);
    expect(text).not.toContain("secret body");
    expect(text).not.toContain("user/alice");
  });

  it("ends a failing call as an error and rethrows it untouched", async () => {
    telemetry = await startMemoryTelemetry();
    class Broken extends MemoryLog {
      #reason = "disk full";
      override async append(): Promise<never> {
        throw new RangeError(this.#reason);
      }
      override async *scan(): AsyncGenerator<never> {
        yield* [];
        throw new TypeError("bad shard");
      }
    }
    const log: RecordLog = instrumentLog(new Broken("x", "personal"));
    await expect(log.append([])).rejects.toThrow("disk full");
    await expect(async () => {
      for await (const _ of log.scan()) {
      }
    }).rejects.toThrow("bad shard");
    const { spans } = await telemetry.exported();
    expect(
      spans.map((s) => [s.name, s.attributes["ynm.outcome"], s.attributes["error.type"]])
    ).toEqual([
      ["store append", "error", "RangeError"],
      ["store scan", "error", "TypeError"],
    ]);
  });
});

describe("dream spans", () => {
  it("one span per run and per pass, with counts and a started event for each", async () => {
    telemetry = await startMemoryTelemetry();
    const judge = new HeuristicJudge();
    const writer = new NoneWriter();
    const ynm = new Ynm({
      mounts: [
        { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
      ],
      actor: "t",
      userId: "u",
      redaction: DEFAULT_REDACTION,
      index: new IndexManager("memory", { fileFor: () => ":memory:" }),
      models: { judge, writer, resolution: { judge: "test", writer: "test" } },
      dream: DreamConfigSchema.parse({}),
    });
    await ynm.remember({ type: "semantic", content: "Releases happen on Fridays" });
    await ynm.remember({ type: "semantic", content: "Releases happen on Fridays." });
    const config = DreamConfigSchema.parse({});
    const report = await dream(ynm, {}, { judge, writer, config });
    const { spans, logs, text } = await telemetry.exported();
    const run = spans.find((s) => s.name === "dream");
    expect(run?.attributes).toMatchObject({
      "ynm.dream.dry_run": false,
      "ynm.dream.judge": judge.name,
      "ynm.dream.fresh": report.fresh,
      "ynm.outcome": "ok",
    });
    const passes = spans.filter(
      (s) => s.name.startsWith("dream ") && s.parentSpanId === run?.spanId
    );
    expect(passes.map((s) => s.attributes["ynm.dream.pass"])).toEqual(
      expect.arrayContaining(["expire", "dedupe", "contradict", "reflect", "normalise"])
    );
    const dedupe = passes.find((s) => s.attributes["ynm.dream.pass"] === "dedupe");
    expect(dedupe?.attributes["ynm.dream.candidates"]).toBe(report.passes.dedupe?.candidates);
    expect(logs.filter((l) => l.eventName === "ynm.dream.pass.started").length).toBe(passes.length);
    expect(logs.some((l) => l.eventName === "ynm.dream.started")).toBe(true);
    expect(text).not.toContain("Fridays");
  });
});
