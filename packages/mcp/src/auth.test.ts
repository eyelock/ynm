import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  authFromEnv,
  clientIdOf,
  IntrospectionVerifier,
  isStaticToken,
  JwksVerifier,
  protectedResourceFor,
  StaticTokenVerifier,
  usernameOf,
  verifierFor,
} from "./auth.js";

describe("auth verifiers (ADR-009)", () => {
  it("static tokens", async () => {
    const v = new StaticTokenVerifier(["s3cret"], ["memory:write"]);
    const info = await v.verifyAccessToken("s3cret");
    expect(info.scopes).toEqual(["memory:write"]);
    // Marked as a static token, so its writes are recorded as the shared token.
    expect(isStaticToken(info)).toBe(true);
    expect(isStaticToken({ ...info, extra: { sub: "s", iss: "i" } })).toBe(false);
    expect(isStaticToken(undefined)).toBe(false);
    await expect(v.verifyAccessToken("nope")).rejects.toThrow(/invalid token/);
  });

  it("introspection posts the token with client credentials and caches active results", async () => {
    let calls = 0;
    const fetchMock = (async (_url: string | URL, init?: RequestInit) => {
      calls += 1;
      expect(String(init?.body)).toMatch(/token=abc/);
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toMatch(
        /^Basic /
      );
      return new Response(
        JSON.stringify({
          active: true,
          client_id: "agent-1",
          scope: "memory:read memory:write",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const v = new IntrospectionVerifier({
      url: "https://issuer/introspect",
      clientId: "id",
      clientSecret: "s",
      fetch: fetchMock,
    });
    const info = await v.verifyAccessToken("abc");
    expect(info.clientId).toBe("agent-1");
    expect(info.scopes).toEqual(["memory:read", "memory:write"]);
    await v.verifyAccessToken("abc");
    expect(calls).toBe(1);
    const inactive = new IntrospectionVerifier({
      url: "u",
      clientId: "i",
      clientSecret: "s",
      fetch: (async () =>
        new Response(JSON.stringify({ active: false }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    await expect(inactive.verifyAccessToken("x")).rejects.toThrow(/inactive/);
  });

  it("JWT verified against a JWKS", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const jwks = { keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] };
    const jwt = await new SignJWT({ scope: "memory:read", azp: "agent-2" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer("https://issuer")
      .setAudience("ynm")
      .setExpirationTime("1h")
      .sign(privateKey);
    const server = Bun_or_node_server(jwks);
    const v = new JwksVerifier({
      jwksUrl: `${server.url}/jwks`,
      issuer: "https://issuer",
      audience: "ynm",
    });
    const info = await v.verifyAccessToken(jwt);
    expect(info.clientId).toBe("agent-2");
    expect(info.scopes).toEqual(["memory:read"]);
    expect(usernameOf(info)).toBeUndefined();
    // The sign-in name is carried beside the subject, for the telemetry handle only.
    const named = await new SignJWT({ preferred_username: "alice" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer("https://issuer")
      .setSubject("0b7c")
      .setAudience("ynm")
      .setExpirationTime("1h")
      .sign(privateKey);
    const namedInfo = await v.verifyAccessToken(named);
    expect(namedInfo.extra).toMatchObject({ sub: "0b7c", iss: "https://issuer" });
    expect(usernameOf(namedInfo)).toBe("alice");
    const bad = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer("https://other")
      .setAudience("ynm")
      .setExpirationTime("1h")
      .sign(privateKey);
    await expect(v.verifyAccessToken(bad)).rejects.toThrow();
    server.close();
  });

  it("chooses a verifier from the environment", () => {
    expect(authFromEnv({})).toEqual({ mode: "none" });
    expect(authFromEnv({ YNM_MCP_TOKEN: "a, b" })).toEqual({ mode: "bearer", tokens: ["a", "b"] });
    expect(authFromEnv({ YNM_JWKS_URL: "https://i/jwks" }).mode).toBe("jwt");
    expect(verifierFor({ mode: "none" })).toBeUndefined();
    expect(verifierFor({ mode: "bearer", tokens: ["t"] })).toBeInstanceOf(StaticTokenVerifier);
  });
});

describe("auth verifiers reject what they should", () => {
  const introspect = (body: unknown, status = 200, onCall?: () => void) =>
    new IntrospectionVerifier({
      url: "https://issuer/introspect",
      clientId: "id",
      clientSecret: "s",
      cacheMs: 60_000,
      fetch: (async () => {
        onCall?.();
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch,
    });

  it("a static verifier with no tokens accepts nothing, not even an empty token", async () => {
    const v = new StaticTokenVerifier([]);
    await expect(v.verifyAccessToken("")).rejects.toMatchObject({ code: "invalid_token" });
    const info = await new StaticTokenVerifier(["t"]).verifyAccessToken("t");
    expect(info.scopes).toEqual([]);
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it("introspection maps an endpoint failure to invalid_token so the transport answers 401", async () => {
    await expect(introspect({ error: "boom" }, 503).verifyAccessToken("t")).rejects.toMatchObject({
      code: "invalid_token",
      message: expect.stringMatching(/introspection failed: 503/),
    });
    await expect(introspect({}).verifyAccessToken("t")).rejects.toThrow(/token inactive/);
  });

  it("introspection carries preferred_username, else RFC 7662's username, as the sign-in name", async () => {
    const preferred = await introspect({
      active: true,
      sub: "0b7c",
      preferred_username: "alice",
      username: "other",
    }).verifyAccessToken("t");
    expect(usernameOf(preferred)).toBe("alice");
    const plain = await introspect({
      active: true,
      sub: "0b7c",
      username: "bob",
    }).verifyAccessToken("t");
    expect(usernameOf(plain)).toBe("bob");
    expect(usernameOf(undefined)).toBeUndefined();
  });

  it("introspection falls back to sub, then unknown, for the client id and to no scopes", async () => {
    const bySub = await introspect({ active: true, sub: "user-9" }).verifyAccessToken("t");
    expect(bySub.clientId).toBe("user-9");
    expect(bySub.scopes).toEqual([]);
    // With no iss in the response, the introspection endpoint's origin stands in as the issuer.
    expect(bySub.extra).toEqual({ sub: "user-9", iss: "https://issuer" });
    expect(bySub.expiresAt).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 3599);
    const anon = await introspect({ active: true }).verifyAccessToken("t");
    expect(anon.clientId).toBe("unknown");
    // Only a client the token names is kept as its client, never the sub or placeholder fallback.
    expect(clientIdOf(bySub)).toBeUndefined();
    expect(clientIdOf(anon)).toBeUndefined();
  });

  it("introspection keeps the client a token names, so a token with no sub can be its client", async () => {
    const info = await introspect({ active: true, client_id: "ci-runner" }).verifyAccessToken("t");
    expect(info.clientId).toBe("ci-runner");
    expect(clientIdOf(info)).toBe("ci-runner");
    expect(info.extra?.sub).toBeUndefined();
    expect(clientIdOf(undefined)).toBeUndefined();
    expect(clientIdOf({ ...info, extra: { client: "" } })).toBeUndefined();
  });

  it("introspection never serves a cached result past the token's expiry", async () => {
    let calls = 0;
    const exp = Math.floor(Date.now() / 1000) - 1;
    const v = introspect({ active: true, client_id: "c", exp }, 200, () => {
      calls += 1;
    });
    expect((await v.verifyAccessToken("t")).expiresAt).toBe(exp);
    await v.verifyAccessToken("t");
    expect(calls).toBe(2);
  });

  describe("JWT", () => {
    let server: { url: string; close: () => void };
    let privateKey: CryptoKey;
    let v: JwksVerifier;

    beforeAll(async () => {
      const pair = await generateKeyPair("RS256");
      privateKey = pair.privateKey;
      const jwk = await exportJWK(pair.publicKey);
      server = Bun_or_node_server({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] });
      v = new JwksVerifier({ jwksUrl: `${server.url}/jwks`, issuer: "https://issuer" });
    });
    afterAll(() => server.close());

    const sign = (claims: Record<string, unknown>, exp: string | number = "1h", kid = "k1") =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer("https://issuer")
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(privateKey);

    it("rejects an expired token as invalid_token", async () => {
      const expired = await sign({}, Math.floor(Date.now() / 1000) - 60);
      await expect(v.verifyAccessToken(expired)).rejects.toMatchObject({
        code: "invalid_token",
        message: expect.stringMatching(/exp/),
      });
    });

    it("rejects a malformed token and a token signed with an unknown key", async () => {
      await expect(v.verifyAccessToken("not-a-jwt")).rejects.toMatchObject({
        code: "invalid_token",
      });
      await expect(v.verifyAccessToken("a.b.c")).rejects.toMatchObject({ code: "invalid_token" });
      await expect(v.verifyAccessToken(await sign({}, "1h", "k2"))).rejects.toMatchObject({
        code: "invalid_token",
      });
    });

    it("reads scopes from scp arrays, a custom claim, or none at all", async () => {
      const scp = await v.verifyAccessToken(await sign({ scp: ["a", "b"], client_id: "cid" }));
      expect(scp.scopes).toEqual(["a", "b"]);
      expect(scp.clientId).toBe("cid");

      const custom = new JwksVerifier({ jwksUrl: `${server.url}/jwks`, scopeClaim: "perms" });
      const c = await custom.verifyAccessToken(
        await sign({ perms: "memory:read  memory:write", scope: "ignored", sub: "u1" })
      );
      expect(c.scopes).toEqual(["memory:read", "memory:write"]);
      expect(c.clientId).toBe("u1");
      expect(c.extra).toEqual({ sub: "u1", iss: "https://issuer" });

      const bare = await v.verifyAccessToken(await sign({ scope: 42 }));
      expect(bare.scopes).toEqual([]);
      expect(bare.clientId).toBe("jwt");
      expect(clientIdOf(bare)).toBeUndefined();
      expect(clientIdOf(c)).toBeUndefined();
      expect(clientIdOf(scp)).toBe("cid");
    });

    it("keeps the client a token names, azp before client_id", async () => {
      const azp = await v.verifyAccessToken(await sign({ azp: "ci-runner", client_id: "other" }));
      expect(azp.extra?.sub).toBeUndefined();
      expect(clientIdOf(azp)).toBe("ci-runner");
      const cid = await v.verifyAccessToken(await sign({ client_id: "worker" }));
      expect(clientIdOf(cid)).toBe("worker");
    });
  });

  it("builds introspection and JWT verifiers from the environment", () => {
    const intro = authFromEnv({ YNM_OAUTH_INTROSPECTION_URL: "https://i/introspect" });
    expect(intro).toEqual({
      mode: "introspection",
      url: "https://i/introspect",
      clientId: "",
      clientSecret: "",
    });
    expect(verifierFor(intro)).toBeInstanceOf(IntrospectionVerifier);
    const jwt = authFromEnv({
      YNM_JWKS_URL: "https://i/jwks",
      YNM_JWT_ISSUER: "https://i",
      YNM_JWT_AUDIENCE: "ynm",
      YNM_MCP_TOKEN: "ignored",
    });
    expect(jwt).toEqual({
      mode: "jwt",
      jwksUrl: "https://i/jwks",
      issuer: "https://i",
      audience: "ynm",
    });
    expect(verifierFor(jwt)).toBeInstanceOf(JwksVerifier);
    expect(authFromEnv({ YNM_MCP_TOKEN: " , " })).toEqual({ mode: "bearer", tokens: [] });
  });
});

import { createServer } from "node:http";

function Bun_or_node_server(jwks: unknown): { url: string; close: () => void } {
  const srv = createServer((req, res) => {
    if (req.url === "/jwks") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jwks));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  srv.listen(0);
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

describe("protected resource from the auth config", () => {
  const jwt = { mode: "jwt" as const, jwksUrl: "https://i/jwks", issuer: "https://i" };

  it("names the JWT issuer as where to sign in, with the public URL as the resource", () => {
    expect(
      protectedResourceFor(
        { ...jwt, audience: "https://aud/mcp" },
        { YNM_PUBLIC_URL: " https://memory.example.com/mcp " },
        ["memory:read"]
      )
    ).toEqual({
      authorizationServers: ["https://i"],
      resource: "https://memory.example.com/mcp",
      scopesSupported: ["memory:read"],
    });
    expect(protectedResourceFor({ ...jwt, audience: "https://aud/mcp" }, {}, [])).toEqual({
      authorizationServers: ["https://i"],
      resource: "https://aud/mcp",
      scopesSupported: undefined,
    });
  });

  it("advertises nothing without an issuer to sign in at", () => {
    expect(protectedResourceFor({ mode: "jwt", jwksUrl: "https://i/jwks" }, {})).toBeUndefined();
    expect(protectedResourceFor({ mode: "bearer", tokens: ["t"] }, {})).toBeUndefined();
    expect(protectedResourceFor({ mode: "none" }, {})).toBeUndefined();
  });
});
