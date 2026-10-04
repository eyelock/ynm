import { personIdFor } from "@ynm/model";
import { MemoryLog } from "@ynm/store";
import { DEFAULT_REDACTION } from "./config.js";
import { IndexManager } from "./indexing.js";
import { toolSpec } from "./tools.js";
import { Ynm } from "./ynm.js";

const auth0 = { issuer: "https://tenant.us.auth0.com/", subject: "auth0|6ac0" };
const okta = { issuer: "https://login.example.com/", subject: "00u1abc" };

/** A hosted store: one distributed mount, no personal one. */
function hosted(log = new MemoryLog("org", "distributed")): Ynm {
  return new Ynm({
    mounts: [{ id: "org", level: "distributed", location: "mem", log }],
    actor: "user:ynm-eyelock",
    userId: "ynm-eyelock",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
  });
}

function run(y: Ynm, name: string, input: Record<string, unknown>) {
  const s = toolSpec(name);
  if (!s) throw new Error(`missing ${name}`);
  return s.run(y, s.input.parse(input));
}

describe("people on a hosted store (ADR-017)", () => {
  it("a signed-in person's writes are theirs, in their own namespace unless they name one", async () => {
    const base = hosted();
    const person = await base.personFor(auth0);
    const me = base.as({ person, client: "claude-code", login: auth0 });
    const own = await me.remember({
      type: "semantic",
      level: "distributed",
      content: "Deploys are on Thursdays",
    });
    const shared = await me.remember({
      type: "semantic",
      level: "distributed",
      content: "Releases are cut from develop",
      namespace: "common",
    });
    const mine = await base.find(own.memoryId);
    expect(mine?.namespace).toBe(`user/${person}`);
    expect(mine?.current.provenance).toMatchObject({
      actor: `user:${person}`,
      client: "claude-code",
    });
    expect((await base.find(shared.memoryId))?.namespace).toBe("common");
    await me.supersede({ memoryId: own.memoryId, content: "Deploys are on Fridays" });
    expect((await base.find(own.memoryId))?.current.provenance.actor).toBe(`user:${person}`);
    // The view changes nothing for anyone else.
    expect(base.caller).toBeUndefined();
    const server = await base.remember({
      type: "semantic",
      level: "distributed",
      content: "Backups run nightly",
    });
    const record = await base.find(server.memoryId);
    expect(record?.namespace).toBe("common");
    expect(record?.current.provenance.actor).toBe("user:ynm-eyelock");
    expect(record?.current.provenance.client).toBeUndefined();
  });

  it("a personal store files unnamed writes under the user, as before", async () => {
    const y = new Ynm({
      mounts: [
        { id: "p", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
      ],
      actor: "user:david",
      userId: "david",
      redaction: DEFAULT_REDACTION,
    });
    const a = await y.remember({ type: "semantic", content: "Tabs over spaces" });
    const b = await y.remember({ type: "semantic", content: "Dark mode", namespace: "common" });
    expect((await y.find(a.memoryId))?.namespace).toBe("user/david");
    expect((await y.find(b.memoryId))?.namespace).toBe("user/david");
  });

  it("nicknames are set and cleared in the shared document and shown as the author", async () => {
    const log = new MemoryLog("org", "distributed");
    const base = hosted(log);
    const person = personIdFor(auth0);
    const me = base.as({ person, login: auth0 });
    const w = await me.remember({
      type: "semantic",
      level: "distributed",
      content: "Use pnpm, not npm",
    });
    expect(await base.authorOf(`user:${person}`)).toBe(person);
    await base.setNickname(person, "David");
    // Another process sees it through the store, not the cache.
    expect((await hosted(log).people()).people[person]?.nickname).toBe("David");
    expect(await base.authorOf(`user:${person}`)).toBe("David");
    expect(await base.authorOf("user:ynm-eyelock")).toBeUndefined();
    const hits = await base.recall({ text: "pnpm" });
    expect(hits.find((h) => h.memoryId === w.memoryId)?.author).toBe("David");
    await base.setNickname(person, undefined);
    expect((await base.people(true)).people[person]?.nickname).toBeUndefined();
    await expect(base.setNickname("david", "x")).rejects.toThrow(/person id/);
  });

  it("linking a second login keeps one person across identity providers", async () => {
    const log = new MemoryLog("org", "distributed");
    const base = hosted(log);
    const person = await base.personFor(auth0);
    expect(await base.personFor(okta)).not.toBe(person);
    await base.linkLogin(okta, person);
    expect(await base.personFor(okta)).toBe(person);
    // Linking it elsewhere moves it.
    const other = personIdFor({ issuer: "x", subject: "y" });
    await base.linkLogin(okta, other);
    const doc = await base.people(true);
    expect(doc.people[person]?.logins).toEqual([]);
    expect(await hosted(log).personFor(okta)).toBe(other);
  });

  it("a store with no document-keeping mount keeps no people", async () => {
    const log = new MemoryLog("org", "distributed");
    const bare = Object.assign(Object.create(log), {
      readDocument: undefined,
      writeDocument: undefined,
    });
    const y = hosted(bare);
    expect((await y.people()).people).toEqual({});
    await expect(y.setNickname(personIdFor(auth0), "David")).rejects.toThrow(/keeps no people/);
  });

  it("memory_people acts on the caller only", async () => {
    const base = hosted();
    const person = await base.personFor(auth0);
    const me = base.as({ person, client: "claude-code", login: auth0 });
    expect((await run(me, "memory_people", { action: "whoami" })).data).toEqual({
      person,
      nickname: null,
      client: "claude-code",
      login: auth0,
    });
    expect(
      (await run(me, "memory_people", { action: "nickname", nickname: "David" })).data
    ).toEqual({
      person,
      nickname: "David",
    });
    await expect(run(me, "memory_people", { action: "nickname" })).rejects.toThrow(
      /needs a nickname/
    );
    expect((await run(me, "memory_people", { action: "clear" })).data).toEqual({
      person,
      nickname: null,
    });
    await expect(run(base, "memory_people", { action: "whoami" })).rejects.toThrow(
      /signed-in caller/
    );
  });
});
