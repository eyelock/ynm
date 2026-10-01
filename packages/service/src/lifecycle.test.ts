import { DreamConfigSchema } from "@ynm/model";
import { HeuristicJudge, NoneWriter } from "@ynm/models";
import { MemoryLog } from "@ynm/store";
import { makeRecord } from "@ynm/store/testing";
import { DEFAULT_REDACTION } from "./config.js";
import { IndexManager } from "./indexing.js";
import { durationMs, Lifecycle } from "./lifecycle.js";
import { Ynm } from "./ynm.js";

describe("lifecycle (sessions and expire pass)", () => {
  let t = Date.parse("2026-09-29T00:00:00.000Z");
  const now = () => new Date(t);
  const ynm = new Ynm({
    mounts: [
      { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
    ],
    actor: "t",
    userId: "u",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
    now,
  });
  const life = new Lifecycle(ynm, now);

  it("parses durations", () => {
    expect(durationMs("PT1H")).toBe(3_600_000);
    expect(durationMs("P1D")).toBe(86_400_000);
    expect(() => durationMs("1h")).toThrow();
  });

  it("starts a session with a context block and a session namespace", async () => {
    const s = await life.start({});
    expect(s.namespace).toBe(`session/${s.sessionId}`);
    expect(s.context.markdown).toMatch(/^## Memory/);
  });

  it("expires working memory after its ttl, and end runs the pass", async () => {
    const s = await life.start({ sessionId: "abc" });
    await ynm.remember({
      type: "working",
      namespace: s.namespace,
      content: "scratch",
      ttl: "PT1H",
    });
    await ynm.remember({ type: "semantic", content: "keep" });
    t += 30 * 60_000;
    expect((await life.consolidate({ dryRun: true })).passes.expire?.changed).toEqual([]);
    t += 31 * 60_000;
    const dry = await life.consolidate({ dryRun: true });
    expect(dry.passes.expire?.changed).toHaveLength(1);
    expect((await ynm.list({ type: "working", includeTombstoned: false })).length).toBe(1);
    const end = await life.end({ sessionId: "abc" });
    expect(end.expired).toHaveLength(1);
    expect((await ynm.list({ type: "working", includeTombstoned: false })).length).toBe(0);
    expect((await ynm.list({ type: "semantic", includeTombstoned: false })).length).toBe(1);
  });
});

describe("lifecycle edges", () => {
  function fresh(extra: Partial<ConstructorParameters<typeof Ynm>[0]> = {}) {
    let t = Date.parse("2026-09-29T00:00:00.000Z");
    const now = () => new Date(t);
    const ynm = new Ynm({
      mounts: [
        { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
      ],
      actor: "t",
      userId: "u",
      redaction: DEFAULT_REDACTION,
      index: new IndexManager("memory", { fileFor: () => ":memory:" }),
      now,
      ...extra,
    });
    return { ynm, life: new Lifecycle(ynm, now), advance: (ms: number) => (t += ms) };
  }

  it("parses every duration unit the schema allows", () => {
    const day = 86_400_000;
    expect(durationMs("P1Y")).toBe(365 * day);
    expect(durationMs("P1M")).toBe(30 * day);
    expect(durationMs("P2W")).toBe(14 * day);
    expect(durationMs("PT1M")).toBe(60_000);
    expect(durationMs("PT30S")).toBe(30_000);
    expect(durationMs("P1DT1H1M1S")).toBe(day + 3_661_000);
  });

  it("end without expire leaves working memory alone", async () => {
    const { ynm, life, advance } = fresh();
    await ynm.remember({ type: "working", namespace: "session/s1", content: "x", ttl: "PT1M" });
    advance(120_000);
    expect(await life.end({ sessionId: "s1", expire: false })).toEqual({
      sessionId: "s1",
      expired: [],
    });
    expect((await ynm.list({ type: "working", includeTombstoned: false })).length).toBe(1);
  });

  it("expireSession expires only due working memory in that session; no ttl means never", async () => {
    const { ynm, life, advance } = fresh();
    const due = await ynm.remember({
      type: "working",
      namespace: "session/s2",
      content: "due",
      ttl: "PT1M",
    });
    // A record written without a ttl (by another tool) never expires.
    await ynm
      .mount("personal")
      .log.append([
        makeRecord({ type: "working", namespace: "session/s2", content: "kept forever" }),
      ]);
    await ynm.remember({ type: "working", namespace: "session/other", content: "o", ttl: "PT1M" });
    advance(9 * 3_600_000);
    expect(await life.expireSession("s2")).toEqual({ sessionId: "s2", expired: [due.memoryId] });
    const left = (await ynm.list({ type: "working", includeTombstoned: false })).map(
      (m) => m.current.content
    );
    expect(left.sort()).toEqual(["kept forever", "o"]);
  });

  it("consolidate skips the expire pass when it is not requested", async () => {
    const { life } = fresh();
    expect(await life.consolidate({ passes: ["dedupe"] })).toEqual({ dryRun: false, passes: {} });
  });

  it("runs the full engine when models and dream config are present", async () => {
    const { life } = fresh({
      models: {
        judge: new HeuristicJudge(),
        writer: new NoneWriter(),
        resolution: { judge: "heuristic", writer: "none" },
      },
      dream: DreamConfigSchema.parse({}),
    });
    const report = await life.consolidate({ dryRun: true });
    expect(report.full).toBeDefined();
    expect(report.dryRun).toBe(true);
    expect(Object.keys(report.passes).sort()).toEqual(
      Object.keys(report.full?.passes ?? {}).sort()
    );
    for (const [k, v] of Object.entries(report.passes)) {
      expect(v.candidates).toBe(
        report.full?.passes[k as keyof typeof report.full.passes]?.candidates
      );
      expect(v).toEqual({ candidates: v.candidates, changed: v.changed });
    }
  });
});
