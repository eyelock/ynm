import { MemoryLog } from "@ynm/store";
import { DEFAULT_REDACTION } from "./config.js";
import { IndexManager } from "./indexing.js";
import { TOOL_NAMES, TOOL_SPECS, toolSpec } from "./tools.js";
import { Ynm } from "./ynm.js";

function make(): Ynm {
  return new Ynm({
    mounts: [
      { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
    ],
    actor: "t",
    userId: "u",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
  });
}

describe("tool specs (ADR-008)", () => {
  it("defines the ten tools with unique names and commands", () => {
    expect(TOOL_NAMES).toHaveLength(10);
    expect(new Set(TOOL_NAMES).size).toBe(10);
    expect(new Set(TOOL_SPECS.map((t) => t.command)).size).toBe(10);
  });

  it("remember warns about similar memories instead of refusing", async () => {
    const y = make();
    const remember = toolSpec("memory_remember");
    if (!remember) throw new Error("missing");
    const first = await remember.run(
      y,
      remember.input.parse({ type: "semantic", content: "Notes anchor to the root commit" })
    );
    expect(first.guidance).toBeUndefined();
    const second = await remember.run(
      y,
      remember.input.parse({ type: "semantic", content: "Notes are anchored to the root commit" })
    );
    expect(second.guidance).toMatch(/similar memory exists/);
  });

  it("session start then end round-trips through the specs", async () => {
    const y = make();
    const session = toolSpec("memory_session");
    if (!session) throw new Error("missing");
    const started = (await session.run(y, session.input.parse({ action: "start" }))).data as {
      sessionId: string;
      namespace: string;
    };
    expect(started.namespace).toMatch(/^session\//);
    const ended = (
      await session.run(y, session.input.parse({ action: "end", sessionId: started.sessionId }))
    ).data as { expired: string[] };
    expect(ended.expired).toEqual([]);
    await expect(session.run(y, session.input.parse({ action: "end" }))).rejects.toThrow(
      /sessionId/
    );
  });

  it("status reports mounts and index freshness", async () => {
    const status = toolSpec("memory_status");
    if (!status) throw new Error("missing");
    const data = (await status.run(make(), {})).data as { mounts: unknown[]; index: unknown[] };
    expect(data.mounts).toHaveLength(1);
    expect(data.index).toHaveLength(1);
  });
});
