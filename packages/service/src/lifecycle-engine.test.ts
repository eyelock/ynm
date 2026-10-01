import { DreamConfigSchema } from "@ynm/model";
import { HeuristicJudge, NoneWriter } from "@ynm/models";
import { MemoryLog } from "@ynm/store";
import { DEFAULT_REDACTION } from "./config.js";
import type { DreamOptions } from "./dream/engine.js";
import type { DreamReport } from "./dream/types.js";
import { Lifecycle } from "./lifecycle.js";
import { Ynm } from "./ynm.js";

const calls: Array<{ input: unknown; opts: DreamOptions }> = [];

vi.mock("./dream/engine.js", () => ({
  dream: async (_ynm: unknown, input: unknown, opts: DreamOptions): Promise<DreamReport> => {
    calls.push({ input, opts });
    return {
      dryRun: false,
      judge: { name: opts.judge.name, calibrated: opts.judge.calibrated },
      writer: opts.writer.name,
      passes: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
    };
  },
}));

describe("lifecycle with the full engine", () => {
  it("hands the configured models, thresholds and clock to the engine, and ends cleanly when it reports no expire pass", async () => {
    const judge = new HeuristicJudge();
    const writer = new NoneWriter();
    const dream = DreamConfigSchema.parse({ maxPairsPerRun: 7 });
    const ynm = new Ynm({
      mounts: [
        { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
      ],
      actor: "t",
      userId: "u",
      redaction: DEFAULT_REDACTION,
      models: { judge, writer, resolution: { judge: "h", writer: "n" } },
      dream,
    });
    const now = () => new Date("2026-09-29T00:00:00.000Z");
    const life = new Lifecycle(ynm, now);
    expect(await life.end({ sessionId: "s9" })).toEqual({ sessionId: "s9", expired: [] });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.input).toMatchObject({ passes: ["expire"], namespace: "session/s9" });
    expect(call?.opts.judge).toBe(judge);
    expect(call?.opts.writer).toBe(writer);
    expect(call?.opts.config.maxPairsPerRun).toBe(7);
    expect(call?.opts.now).toBe(now);
  });
});
