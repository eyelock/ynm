import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FileOAuthProvider,
  hasRemoteCredentials,
  loginRemote,
  logoutRemote,
  remoteAuthPath,
} from "./auth.js";

/**
 * A fake hosted ynm and its identity provider on one origin: protected resource metadata
 * (RFC 9728), authorization server metadata (RFC 8414), dynamic registration, an authorize
 * endpoint that signs in at once, and a token endpoint that checks PKCE.
 */
interface FakeIdp {
  origin: string;
  url: string;
  registrations: Array<{ client_id: string; redirect_uris: string[] }>;
  refreshes: number;
  /** When set, /authorize sends the person back with this error instead of a code. */
  deny?: string;
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s;
}

async function startFakeIdp(): Promise<FakeIdp> {
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>();
  const refreshTokens = new Set<string>();
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", fake.origin);
    const json = (status: number, value: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    const issue = (scope: string) => {
      n += 1;
      const refresh = `RT-secret-${n}`;
      refreshTokens.add(refresh);
      json(200, {
        access_token: `AT-secret-${n}`,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 3600,
        scope,
      });
    };
    switch (u.pathname) {
      case "/.well-known/oauth-protected-resource/mcp":
        return json(200, {
          resource: fake.url,
          authorization_servers: [fake.origin],
          scopes_supported: ["memory:read", "memory:write"],
        });
      case "/.well-known/oauth-authorization-server":
        return json(200, {
          issuer: fake.origin,
          authorization_endpoint: `${fake.origin}/authorize`,
          token_endpoint: `${fake.origin}/token`,
          registration_endpoint: `${fake.origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      case "/register": {
        const meta = JSON.parse(await body(req)) as { redirect_uris: string[] };
        const reg = { ...meta, client_id: `client-${fake.registrations.length + 1}` };
        fake.registrations.push(reg);
        return json(201, reg);
      }
      case "/authorize": {
        const redirect = new URL(u.searchParams.get("redirect_uri") as string);
        redirect.searchParams.set("state", u.searchParams.get("state") ?? "");
        if (fake.deny) {
          redirect.searchParams.set("error", "access_denied");
          redirect.searchParams.set("error_description", fake.deny);
        } else {
          const code = `code-${codes.size + 1}`;
          codes.set(code, {
            challenge: u.searchParams.get("code_challenge") as string,
            clientId: u.searchParams.get("client_id") as string,
            redirectUri: u.searchParams.get("redirect_uri") as string,
          });
          redirect.searchParams.set("code", code);
        }
        return res.writeHead(302, { Location: redirect.href }).end();
      }
      case "/token": {
        const form = new URLSearchParams(await body(req));
        if (form.get("grant_type") === "refresh_token") {
          const rt = form.get("refresh_token") as string;
          if (!refreshTokens.delete(rt)) return json(400, { error: "invalid_grant" });
          fake.refreshes += 1;
          return issue("memory:read memory:write");
        }
        const pending = codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const s256 = createHash("sha256").update(verifier).digest("base64url");
        if (
          !pending ||
          pending.challenge !== s256 ||
          pending.clientId !== form.get("client_id") ||
          pending.redirectUri !== form.get("redirect_uri")
        )
          return json(400, { error: "invalid_grant" });
        codes.delete(form.get("code") as string);
        return issue("memory:read memory:write");
      }
      default:
        return json(404, { error: "not_found" });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake: FakeIdp = {
    origin,
    url: `${origin}/mcp`,
    registrations: [],
    refreshes: 0,
    close: () => new Promise((r) => server.close(() => r())),
  };
  return fake;
}

describe("remote sign-in", () => {
  let idp: FakeIdp;
  const home = mkdtempSync(join(tmpdir(), "ynm-remote-auth-"));
  const lines: string[] = [];
  const opened: URL[] = [];
  /** A browser that signs in at once: follows /authorize back to the loopback callback. */
  const browser = async (u: URL) => {
    opened.push(u);
    await fetch(u);
  };
  const base = () => ({
    home,
    mountId: "team",
    url: idp.url,
    openBrowser: browser,
    print: (l: string) => lines.push(l),
  });
  const logged = vi.fn();

  beforeAll(async () => {
    idp = await startFakeIdp();
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation(logged);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await idp.close();
  });
  afterEach(() => {
    idp.deny = undefined;
  });

  it("signs in through the browser and stores tokens owner-only, without printing them", async () => {
    const result = await loginRemote(base());
    expect(result.scopes).toBe("memory:read memory:write");
    expect(opened).toHaveLength(1);
    expect(lines).toEqual([`Open this URL to sign in: ${opened[0]?.href}`]);
    expect(opened[0]?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(opened[0]?.searchParams.get("resource")).toBe(idp.url);

    const file = remoteAuthPath(home, "team");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "auth")).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored).toMatchObject({
      url: idp.url,
      clientInformation: { client_id: "client-1" },
      tokens: { access_token: "AT-secret-1", refresh_token: "RT-secret-1" },
    });
    expect(stored.codeVerifier).toBeUndefined();
    expect(idp.registrations[0]).toMatchObject({
      redirect_uris: [stored.redirectUrl],
      token_endpoint_auth_method: "none",
      client_name: "ynm",
    });
    expect(stored.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(hasRemoteCredentials(home, "team")).toBe(true);
    expect(hasRemoteCredentials(home, "team", idp.url)).toBe(true);

    const everything = [...lines, ...logged.mock.calls.flat().map(String)].join("\n");
    expect(everything).not.toMatch(/secret/);
  });

  it("returns without a browser when already signed in", async () => {
    const before = opened.length;
    const result = await loginRemote(base());
    expect(result.scopes).toBe("memory:read memory:write");
    expect(opened).toHaveLength(before);
    expect(idp.refreshes).toBe(1);
    expect(idp.registrations).toHaveLength(1);
  });

  it("registers again when the registered loopback port is taken", async () => {
    const provider = new FileOAuthProvider({ home, mountId: "team", url: idp.url });
    provider.invalidateCredentials("tokens");
    const port = Number(new URL(provider.registeredRedirectUrl as string).port);
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", r));
    try {
      await loginRemote(base());
    } finally {
      await new Promise((r) => squatter.close(r));
    }
    expect(idp.registrations).toHaveLength(2);
    const stored = JSON.parse(readFileSync(remoteAuthPath(home, "team"), "utf8"));
    expect(stored.clientInformation.client_id).toBe("client-2");
    expect(stored.redirectUrl).not.toBe(`http://127.0.0.1:${port}/callback`);
    expect(idp.registrations[1]?.redirect_uris).toEqual([stored.redirectUrl]);
  });

  it("treats a mount pointed at another url as signed out", () => {
    const other = `${idp.origin}/elsewhere/mcp`;
    const provider = new FileOAuthProvider({ home, mountId: "team", url: other });
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toBeUndefined();
    expect(hasRemoteCredentials(home, "team", other)).toBe(false);
  });

  it("throws a sign-in error instead of opening a browser outside login", async () => {
    const provider = new FileOAuthProvider({ home, mountId: "fresh", url: idp.url });
    await expect(provider.redirectToAuthorization(new URL(idp.origin))).rejects.toThrow(
      "not signed in to fresh: run `ynm login fresh`"
    );
  });

  it("logs out by forgetting the credentials file", async () => {
    expect(await logoutRemote({ home, mountId: "team" })).toBe(true);
    expect(hasRemoteCredentials(home, "team")).toBe(false);
    expect(await logoutRemote({ home, mountId: "team" })).toBe(false);
  });

  it("rejects with the identity provider's description when sign-in is refused", async () => {
    idp.deny = "alice declined";
    await expect(loginRemote({ ...base(), mountId: "denied" })).rejects.toThrow(
      "sign-in failed: alice declined"
    );
    expect(hasRemoteCredentials(home, "denied")).toBe(false);
  });

  it("times out when the browser never comes back", async () => {
    await expect(
      loginRemote({ ...base(), mountId: "slow", openBrowser: async () => {}, timeoutMs: 200 })
    ).rejects.toThrow("sign-in timed out");
  });

  it("still prints the URL when no browser can be opened", async () => {
    lines.length = 0;
    await expect(
      loginRemote({
        ...base(),
        mountId: "headless",
        openBrowser: async () => {
          throw new Error("no opener");
        },
        timeoutMs: 200,
      })
    ).rejects.toThrow("sign-in timed out");
    expect(lines[0]).toMatch(/^Open this URL to sign in: http:\/\/127\.0\.0\.1:\d+\/authorize\?/);
  });
});
