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
import { hostedAudit, loginOf } from "./identity.js";
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

async function hosted(provider: "git-notes" | "sqlite") {
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
    verifier: idp,
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
