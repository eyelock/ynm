import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  authFromEnv,
  IntrospectionVerifier,
  JwksVerifier,
  StaticTokenVerifier,
  verifierFor,
} from "./auth.js";

describe("auth verifiers (ADR-009)", () => {
  it("static tokens", async () => {
    const v = new StaticTokenVerifier(["s3cret"], ["memory:write"]);
    expect((await v.verifyAccessToken("s3cret")).scopes).toEqual(["memory:write"]);
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
