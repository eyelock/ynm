import { MemoryLog } from "@ynm/store";
import { DEFAULT_REDACTION } from "./config.js";
import { EMPTY_CONTEXT_GUIDANCE } from "./hooks/intent.js";
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
  it("defines the eleven tools with unique names and commands", () => {
    expect(TOOL_NAMES).toHaveLength(11);
    expect(new Set(TOOL_NAMES).size).toBe(11);
    expect(new Set(TOOL_SPECS.map((t) => t.command)).size).toBe(11);
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

describe("tool specs drive the service", () => {
  function run(y: Ynm, name: string, input: Record<string, unknown>) {
    const s = toolSpec(name);
    if (!s) throw new Error(`missing ${name}`);
    return s.run(y, s.input.parse(input));
  }

  it("recall guides the agent when nothing matches and stays quiet when something does", async () => {
    const y = make();
    const empty = await run(y, "memory_recall", { text: "nothing here" });
    expect(empty.data).toEqual([]);
    expect(empty.guidance).toMatch(/No matches/);
    await run(y, "memory_remember", { type: "semantic", content: "Deploys go out on Fridays" });
    const hit = await run(y, "memory_recall", { text: "Fridays" });
    expect((hit.data as Array<{ content: string }>)[0]?.content).toBe("Deploys go out on Fridays");
    expect(hit.guidance).toBeUndefined();
  });

  it("context and session start say there is no memory yet instead of a bare heading", async () => {
    const y = make();
    const empty = await run(y, "memory_context", {});
    expect((empty.data as { markdown: string }).markdown).toBe("");
    expect(empty.guidance).toBe(EMPTY_CONTEXT_GUIDANCE);
    const started = await run(y, "memory_session", { action: "start" });
    expect((started.data as { context: { markdown: string } }).context.markdown).toBe("");
    expect(started.guidance).toMatch(/^No memory yet\. .* Write working memory to namespace /);
    await run(y, "memory_remember", { type: "semantic", content: "Deploys go out on Fridays" });
    const some = await run(y, "memory_context", {});
    expect((some.data as { markdown: string }).markdown).toMatch(/^## Memory\n/);
    expect(some.guidance).toBeUndefined();
    const again = await run(y, "memory_session", { action: "start" });
    expect(again.guidance).toMatch(/^Write working memory/);
    // Memory that does not fit the budget is not "no memory".
    const squeezed = await run(y, "memory_context", { budgetTokens: 1 });
    expect((squeezed.data as { markdown: string }).markdown).toBe("");
    expect(squeezed.guidance).toMatch(/^No memory fits the token budget\. Raise budgetTokens/);
  });

  it("counts several similar memories in the remember guidance", async () => {
    const y = make();
    for (const c of ["Release tags are signed", "Release tags are signed by CI"])
      await run(y, "memory_remember", { type: "semantic", content: c });
    const third = await run(y, "memory_remember", {
      type: "semantic",
      content: "Release tags are signed with the CI key",
    });
    expect(third.guidance).toMatch(/^2 similar memories exist/);
  });

  it("remember gives no similarity guidance without an index", async () => {
    const y = new Ynm({
      mounts: [
        { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
      ],
      actor: "t",
      userId: "u",
      redaction: DEFAULT_REDACTION,
    });
    await run(y, "memory_remember", { type: "semantic", content: "same" });
    expect((await run(y, "memory_remember", { type: "semantic", content: "same" })).guidance).toBe(
      undefined
    );
  });

  it("supersede, annotate, forget, context, consolidate and sync act through the specs", async () => {
    const y = make();
    const created = (
      await run(y, "memory_remember", { type: "semantic", content: "The gate runs nightly" })
    ).data as { memoryId: string };
    const { memoryId } = created;
    await run(y, "memory_supersede", { memoryId, content: "The gate runs hourly" });
    await run(y, "memory_annotate", { memoryId, tags: ["ci"], pinned: true });
    let m = await y.find(memoryId);
    expect(m?.current.content).toBe("The gate runs hourly");
    expect(m?.tags).toContain("ci");
    expect(m?.pinned).toBe(true);

    const ctx = (await run(y, "memory_context", {})).data as { markdown: string };
    expect(ctx.markdown).toContain("The gate runs hourly");

    await run(y, "memory_forget", { memoryId, reason: "obsolete" });
    m = await y.find(memoryId);
    expect(m?.tombstoned).toBe(true);

    const dream = (await run(y, "memory_consolidate", { dryRun: true })).data as {
      dryRun: boolean;
      passes: Record<string, unknown>;
    };
    expect(dream.dryRun).toBe(true);
    expect(Object.keys(dream.passes)).toEqual(["expire"]);

    expect((await run(y, "memory_sync", {})).data).toEqual({});
  });
});
