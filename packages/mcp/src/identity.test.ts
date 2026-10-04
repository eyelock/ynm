import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { personIdFor } from "@ynm/model";
import { initProject } from "@ynm/service";
import { createBare } from "@ynm/store/testing/git";
import { type AuditEvent, Auditor } from "./audit.js";
import { StaticTokenVerifier } from "./auth.js";
import { hostedAudit, loginOf, storeFor } from "./identity.js";
import { startScheduler } from "./scheduler.js";
import { createYnmServer, serviceCache } from "./server.js";
import { startHttp } from "./transport/http.js";

const ISSUER = "https://tenant.us.auth0.com/";

/** An identity provider that vouches for whoever the token names: `alice` or `bob`. */
const idp: OAuthTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token !== "alice" && token !== "bob")
      throw new OAuthError(OAuthErrorCode.InvalidToken, "unknown token");
    return {
      token,
      clientId: "claude-code",
      scopes: ["memory:read", "memory:write"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: { sub: `auth0|${token}`, iss: ISSUER },
    };
  },
};

async function hosted(provider: "git-notes" | "sqlite", verifier: OAuthTokenVerifier = idp) {
  const home = join(mkdtempSync(join(tmpdir(), "ynm-id-home-")), ".ynm");
  mkdirSync(home, { recursive: true });
  let cwd: string;
  if (provider === "git-notes") {
    cwd = await createBare();
    await initProject({ cwd, hooks: false });
  } else {
    cwd = mkdtempSync(join(tmpdir(), "ynm-id-sqlite-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        mounts: [
          {
            id: "project",
            level: "distributed",
            provider: "sqlite",
            path: join(cwd, "store.sqlite"),
          },
        ],
      })
    );
  }
  const opts = {
    cwd,
    env: { ...process.env, YNM_HOME: home, YNM_USER: "server", YNM_NO_CLAUDE_CLI: "1" },
    noPersonal: true,
  };
  const getYnm = serviceCache(opts);
  const events: AuditEvent[] = [];
  const { identify } = hostedAudit({}, false, getYnm);
  const handle = await startHttp(() => createYnmServer(opts, getYnm), {
    port: 0,
    host: "127.0.0.1",
    quiet: true,
    verifier,
    audit: new Auditor({ write: async (e) => void events.push(e) }),
    identify,
  });
  return { handle, getYnm, events };
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "identity-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  return client;
}

function data<T>(r: { structuredContent?: unknown; isError?: boolean; content: unknown }): T {
  if (r.isError) throw new Error(JSON.stringify(r.content));
  return (r.structuredContent as { data: T }).data;
}

describe("loginOf", () => {
  it("needs both an issuer and a subject", () => {
    const base = { token: "t", clientId: "c", scopes: [] };
    expect(loginOf({ ...base, extra: { sub: "s", iss: "i" } })).toEqual({
      issuer: "i",
      subject: "s",
    });
    expect(loginOf({ ...base, extra: { sub: "s" } })).toBeUndefined();
    expect(loginOf(base)).toBeUndefined();
    expect(loginOf(undefined)).toBeUndefined();
  });
});

describe.each(["git-notes", "sqlite"] as const)(
  "signed-in people over HTTP on %s (ADR-017)",
  (provider) => {
    it("attributes writes, files them per person, shows nicknames and audits each request", async () => {
      const { handle, getYnm, events } = await hosted(provider);
      try {
        const alice = await connect(handle.url, "alice");
        const bob = await connect(handle.url, "bob");
        const alicePerson = personIdFor({ issuer: ISSUER, subject: "auth0|alice" });
        const bobPerson = personIdFor({ issuer: ISSUER, subject: "auth0|bob" });

        const written = data<{ memoryId: string }>(
          await alice.callTool({
            name: "memory_remember",
            arguments: {
              type: "semantic",
              level: "distributed",
              content: "Alice deploys on Thursdays",
            },
          })
        );
        await bob.callTool({
          name: "memory_remember",
          arguments: {
            type: "semantic",
            level: "distributed",
            content: "Shared: releases come from develop",
            namespace: "common",
          },
        });
        const ynm = await getYnm();
        const memory = await ynm.find(written.memoryId);
        expect(memory?.namespace).toBe(`user/${alicePerson}`);
        expect(memory?.current.provenance).toMatchObject({
          actor: `user:${alicePerson}`,
          client: "claude-code",
        });

        expect(
          data(
            await alice.callTool({
              name: "memory_people",
              arguments: { action: "nickname", nickname: "Alice" },
            })
          )
        ).toEqual({ person: alicePerson, nickname: "Alice" });
        expect(
          data<{ person: string; login: unknown }>(
            await bob.callTool({ name: "memory_people", arguments: { action: "whoami" } })
          )
        ).toMatchObject({ person: bobPerson, login: { issuer: ISSUER, subject: "auth0|bob" } });
        const hits = data<Array<{ memoryId: string; author?: string }>>(
          await bob.callTool({ name: "memory_recall", arguments: { text: "Thursdays" } })
        );
        expect(hits.find((h) => h.memoryId === written.memoryId)?.author).toBe("Alice");

        const remember = events.find((e) => e.calls.some((c) => c.tool === "memory_remember"));
        expect(remember).toMatchObject({
          person: alicePerson,
          client: "claude-code",
          outcome: "ok",
          status: 200,
        });
        const call = remember?.calls.find((c) => c.tool === "memory_remember");
        expect(call?.memoryIds).toEqual([written.memoryId]);
        expect(call?.inputBytes).toBeGreaterThan(0);
        // Metadata only: no memory content anywhere in the log.
        expect(JSON.stringify(events)).not.toMatch(/Thursdays|develop/);
        await alice.close();
        await bob.close();
      } finally {
        await handle.close();
      }
    });

    it("audits a refused request with its reason and no identity", async () => {
      const { handle, events } = await hosted(provider);
      try {
        const res = await fetch(handle.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer nobody" },
          body: "{}",
        });
        expect(res.status).toBe(401);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          outcome: "refused",
          status: 401,
          reason: "invalid_token",
          calls: [],
        });
        expect(events[0]?.person).toBeUndefined();
        // Health and discovery are not audited.
        await fetch(handle.url.replace(/\/mcp$/, "/health"));
        expect(events).toHaveLength(1);
      } finally {
        await handle.close();
      }
    });
  }
);

describe.each(["git-notes", "sqlite"] as const)("a static token over HTTP on %s", (provider) => {
  it("records writes as token:static, never the server's user, and audits the shared client", async () => {
    const { handle, getYnm, events } = await hosted(provider, new StaticTokenVerifier(["demo"]));
    try {
      const client = await connect(handle.url, "demo");
      const written = data<{ memoryId: string }>(
        await client.callTool({
          name: "memory_remember",
          arguments: { type: "semantic", level: "distributed", content: "Workers share one token" },
        })
      );
      const ynm = await getYnm();
      const memory = await ynm.find(written.memoryId);
      expect(memory?.current.provenance.actor).toBe("token:static");
      expect(memory?.current.provenance.client).toBeUndefined();
      // A shared token is no one's own, so an unnamed write is the team's.
      expect(memory?.namespace).toBe("common");

      // Every other op records the same actor.
      data(
        await client.callTool({
          name: "memory_annotate",
          arguments: { memoryId: written.memoryId, tags: ["ci"] },
        })
      );
      const other = data<{ memoryId: string }>(
        await client.callTool({
          name: "memory_remember",
          arguments: { type: "semantic", level: "distributed", content: "Retired soon" },
        })
      );
      data(
        await client.callTool({
          name: "memory_supersede",
          arguments: { memoryId: other.memoryId, content: "Retired now" },
        })
      );
      data(
        await client.callTool({ name: "memory_forget", arguments: { memoryId: other.memoryId } })
      );
      const records = await ynm.records({ includeTombstoned: true });
      expect(records.map((r) => r.op).sort()).toEqual(
        ["annotate", "create", "create", "supersede", "tombstone"].sort()
      );
      expect(new Set(records.map((r) => r.provenance.actor))).toEqual(new Set(["token:static"]));

      // Readers cope: no author to show, and memory_people says why it has no one to act on.
      const hits = data<Array<{ memoryId: string; author?: string }>>(
        await client.callTool({ name: "memory_recall", arguments: { text: "share one token" } })
      );
      const hit = hits.find((h) => h.memoryId === written.memoryId);
      expect(hit).toBeDefined();
      expect(hit?.author).toBeUndefined();
      const people = await client.callTool({
        name: "memory_people",
        arguments: { action: "whoami" },
      });
      expect(people.isError).toBe(true);
      expect(JSON.stringify(people.content)).toMatch(/static token.*token:static/);

      // The audit event names the shared client and no person, matching the records.
      const remember = events.find((e) => e.calls.some((c) => c.tool === "memory_remember"));
      expect(remember).toMatchObject({ client: "static", outcome: "ok", status: 200 });
      expect(remember?.person).toBeUndefined();
      expect(remember?.calls.find((c) => c.tool === "memory_remember")?.memoryIds).toEqual([
        written.memoryId,
      ]);
      await client.close();
    } finally {
      await handle.close();
    }
  });

  it("keeps the server's own actor for a scheduled dream run, which is no caller", async () => {
    const { handle, getYnm } = await hosted(provider, new StaticTokenVerifier(["demo"]));
    try {
      const client = await connect(handle.url, "demo");
      const written = data<{ memoryId: string }>(
        await client.callTool({
          name: "memory_remember",
          arguments: {
            type: "working",
            level: "distributed",
            content: "scratch for a moment",
            ttl: "PT1S",
            namespace: "session/s1",
          },
        })
      );
      await client.close();
      await new Promise((r) => setTimeout(r, 1100));
      const scheduler = startScheduler(getYnm, { quiet: true });
      await scheduler.dreamNow();
      scheduler.stop();
      expect(scheduler.stats.lastDream?.expire?.changed).toBe(1);
      const records = (await (await getYnm()).records({ includeTombstoned: true })).filter(
        (r) => r.memoryId === written.memoryId
      );
      expect(records.map((r) => [r.op, r.provenance.actor])).toEqual([
        ["create", "token:static"],
        ["tombstone", "user:server"],
      ]);
    } finally {
      await handle.close();
    }
  });
});

describe("storeFor", () => {
  it("is the person for a login, token:static for a static token, else the store itself", async () => {
    const opts = {
      cwd: await createBare(),
      env: {
        ...process.env,
        YNM_HOME: join(mkdtempSync(join(tmpdir(), "ynm-id-home-")), ".ynm"),
        YNM_USER: "server",
        YNM_NO_CLAUDE_CLI: "1",
      },
      noPersonal: true,
    };
    await initProject({ cwd: opts.cwd, hooks: false });
    const ynm = await serviceCache(opts)();
    const remember = async (store: typeof ynm) => {
      const r = await store.remember({ type: "semantic", level: "distributed", content: "x" });
      return (await ynm.find(r.memoryId))?.current.provenance.actor;
    };
    const staticInfo = await new StaticTokenVerifier(["demo"]).verifyAccessToken("demo");
    expect(await remember(await storeFor(ynm, staticInfo))).toBe("token:static");
    const jwt = await idp.verifyAccessToken("alice");
    expect(await remember(await storeFor(ynm, jwt))).toBe(
      `user:${personIdFor({ issuer: ISSUER, subject: "auth0|alice" })}`
    );
    // No auth (stdio, --no-auth), and a client merely named "static" by an identity provider.
    expect(await remember(await storeFor(ynm, undefined))).toBe("user:server");
    expect(
      await remember(await storeFor(ynm, { token: "t", clientId: "static", scopes: [] }))
    ).toBe("user:server");
  });
});

describe("hostedAudit", () => {
  it("is off without auth or when set off, on (stdout) with auth, and reports a bad setting", async () => {
    const getYnm = async () => {
      throw new Error("no store");
    };
    expect(hostedAudit({}, false, getYnm).audit).toBeUndefined();
    expect(hostedAudit({ YNM_AUDIT: '{"sink":"off"}' }, true, getYnm).audit).toBeUndefined();
    expect(hostedAudit({}, true, getYnm).audit).toBeInstanceOf(Auditor);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = hostedAudit({ YNM_AUDIT: '{"sink":"nowhere"}' }, true, getYnm).audit;
    await bad?.around({ method: "POST", url: "http://x/mcp" }, async () => ({ status: 200 }));
    expect(err.mock.calls.some(([m]) => /\[ynm-mcp audit\] off: YNM_AUDIT/.test(String(m)))).toBe(
      true
    );
    err.mockRestore();
  });
});
