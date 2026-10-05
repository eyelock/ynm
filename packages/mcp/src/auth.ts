import { createHash } from "node:crypto";
import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";

const DEFAULT_TTL_S = 3600;
const expiry = (exp?: number): number => exp ?? Math.floor(Date.now() / 1000) + DEFAULT_TTL_S;

/** The SDK maps this code to a 401 with a WWW-Authenticate challenge; anything else is a 500. */
function invalid(message: string): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, message);
}

import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

/**
 * Marks the auth info of a request made with a static token. Such a token is a shared secret that
 * vouches for no one, so its writes are recorded as the shared token, never as a person.
 */
export const STATIC_TOKEN_EXTRA = "staticToken";

/** Whether a request was authenticated by a static token rather than an identity provider. */
export function isStaticToken(info: AuthInfo | undefined): boolean {
  return info?.extra?.[STATIC_TOKEN_EXTRA] === true;
}

/**
 * The client an identity provider's token says it was issued to (JWT `azp` or `client_id`,
 * introspection `client_id`), kept only when the token names one. Unlike `AuthInfo.clientId`, it
 * never falls back to the subject or a placeholder, so a token with no subject can be recorded as
 * its client.
 */
export const CLIENT_ID_EXTRA = "client";

/** The client a token names, if it names one. */
export function clientIdOf(info: AuthInfo | undefined): string | undefined {
  const id = info?.extra?.[CLIENT_ID_EXTRA];
  return typeof id === "string" && id ? id : undefined;
}

/**
 * The sign-in name a token carries (`preferred_username`, or RFC 7662's `username` in an
 * introspection response), kept beside the subject for the telemetry handle only. ynm's own
 * identity (the person id, actors, provenance and audit) reads `iss` and `sub` alone.
 */
export const USERNAME_EXTRA = "preferredUsername";

/** The sign-in name a token carries, if it carries one. */
export function usernameOf(info: AuthInfo | undefined): string | undefined {
  const name = info?.extra?.[USERNAME_EXTRA];
  return typeof name === "string" && name ? name : undefined;
}

/** A claim as a non-empty string, if it is one. */
function claim(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Dev and tests: one or more static tokens, compared in constant time via hashing. */
export class StaticTokenVerifier implements OAuthTokenVerifier {
  private readonly hashes: Set<string>;
  constructor(
    tokens: string[],
    private readonly scopes: string[] = []
  ) {
    this.hashes = new Set(tokens.map((t) => createHash("sha256").update(t).digest("hex")));
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!this.hashes.has(createHash("sha256").update(token).digest("hex")))
      throw invalid("invalid token");
    return {
      token,
      clientId: "static",
      scopes: this.scopes,
      expiresAt: expiry(),
      extra: { [STATIC_TOKEN_EXTRA]: true },
    };
  }
}

export interface IntrospectionOptions {
  /** RFC 7662 introspection endpoint. */
  url: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  /** Cache positive results for this long; default 60 s. */
  cacheMs?: number;
}

/** OAuth 2.0 token introspection (RFC 7662), copied in spirit from ACME's verifier. */
export class IntrospectionVerifier implements OAuthTokenVerifier {
  private readonly cache = new Map<string, { info: AuthInfo; until: number }>();
  constructor(private readonly opts: IntrospectionOptions) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const key = createHash("sha256").update(token).digest("hex");
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.info;
    const f = this.opts.fetch ?? fetch;
    const res = await f(this.opts.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw invalid(`introspection failed: ${res.status}`);
    const data = (await res.json()) as {
      active?: boolean;
      client_id?: string;
      scope?: string;
      exp?: number;
      sub?: string;
      iss?: string;
      preferred_username?: string;
      username?: string;
    };
    if (!data.active) throw invalid("token inactive");
    const info: AuthInfo = {
      token,
      clientId: data.client_id ?? data.sub ?? "unknown",
      scopes: data.scope ? data.scope.split(" ") : [],
      expiresAt: expiry(data.exp),
      // A login needs an issuer; an introspection response may leave it out, so the endpoint stands in.
      extra: {
        sub: data.sub,
        iss: data.iss ?? new URL(this.opts.url).origin,
        ...clientExtra(claim(data.client_id)),
        ...usernameExtra(claim(data.preferred_username) ?? claim(data.username)),
      },
    };
    const until = Math.min(
      Date.now() + (this.opts.cacheMs ?? 60_000),
      data.exp ? data.exp * 1000 : Number.POSITIVE_INFINITY
    );
    this.cache.set(key, { info, until });
    return info;
  }
}

export interface JwksOptions {
  /** JWKS URL of the issuer. */
  jwksUrl: string;
  issuer?: string;
  audience?: string;
  /** Claim holding scopes; default `scope` (space separated) or `scp` (array). */
  scopeClaim?: string;
}

/** JWT access tokens verified against a remote JWKS (jose). */
export class JwksVerifier implements OAuthTokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  constructor(private readonly opts: JwksOptions) {
    this.jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: JWTPayload;
    try {
      payload = (
        await jwtVerify(token, this.jwks, {
          issuer: this.opts.issuer,
          audience: this.opts.audience,
        })
      ).payload;
    } catch (err) {
      throw invalid(err instanceof Error ? err.message : "invalid JWT");
    }
    return {
      token,
      clientId: String(payload.azp ?? payload.client_id ?? payload.sub ?? "jwt"),
      scopes: scopesOf(payload, this.opts.scopeClaim),
      expiresAt: expiry(payload.exp),
      extra: {
        sub: payload.sub,
        iss: payload.iss,
        ...clientExtra(claim(payload.azp) ?? claim(payload.client_id)),
        ...usernameExtra(claim(payload.preferred_username)),
      },
    };
  }
}

function clientExtra(client: string | undefined): Record<string, string> {
  return client ? { [CLIENT_ID_EXTRA]: client } : {};
}

function usernameExtra(name: string | undefined): Record<string, string> {
  return name ? { [USERNAME_EXTRA]: name } : {};
}

function scopesOf(payload: JWTPayload, claim?: string): string[] {
  const raw = claim ? payload[claim] : (payload.scope ?? payload.scp);
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") return raw.split(" ").filter(Boolean);
  return [];
}

export type AuthConfig =
  | { mode: "none" }
  | { mode: "bearer"; tokens: string[] }
  | { mode: "introspection"; url: string; clientId: string; clientSecret: string }
  | { mode: "jwt"; jwksUrl: string; issuer?: string; audience?: string };

export function verifierFor(cfg: AuthConfig): OAuthTokenVerifier | undefined {
  switch (cfg.mode) {
    case "none":
      return undefined;
    case "bearer":
      return new StaticTokenVerifier(cfg.tokens);
    case "introspection":
      return new IntrospectionVerifier({
        url: cfg.url,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
      });
    case "jwt":
      return new JwksVerifier({ jwksUrl: cfg.jwksUrl, issuer: cfg.issuer, audience: cfg.audience });
  }
}

/** Auth config from environment: YNM_MCP_TOKEN (bearer), YNM_OAUTH_INTROSPECTION_URL (+ client id/secret), YNM_JWKS_URL (+ issuer/audience). */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  if (env.YNM_JWKS_URL)
    return {
      mode: "jwt",
      jwksUrl: env.YNM_JWKS_URL,
      issuer: env.YNM_JWT_ISSUER,
      audience: env.YNM_JWT_AUDIENCE,
    };
  if (env.YNM_OAUTH_INTROSPECTION_URL)
    return {
      mode: "introspection",
      url: env.YNM_OAUTH_INTROSPECTION_URL,
      clientId: env.YNM_OAUTH_CLIENT_ID ?? "",
      clientSecret: env.YNM_OAUTH_CLIENT_SECRET ?? "",
    };
  if (env.YNM_MCP_TOKEN)
    return {
      mode: "bearer",
      tokens: env.YNM_MCP_TOKEN.split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    };
  return { mode: "none" };
}

/**
 * What the server advertises so a client can find where to sign in (RFC 9728): the
 * authorization servers, and the resource its tokens must be issued for.
 */
export interface ProtectedResource {
  authorizationServers: string[];
  /** The MCP URL tokens are issued for; when unset, the request's own origin plus `/mcp`. */
  resource?: string;
  scopesSupported?: string[];
}

/**
 * The protected resource for an auth config, when it names an issuer a client can sign in at:
 * JWT auth with `YNM_JWT_ISSUER`. The resource is `YNM_PUBLIC_URL`, else the JWT audience.
 */
export function protectedResourceFor(
  cfg: AuthConfig,
  env: NodeJS.ProcessEnv = process.env,
  scopes?: string[]
): ProtectedResource | undefined {
  if (cfg.mode !== "jwt" || !cfg.issuer) return undefined;
  return {
    authorizationServers: [cfg.issuer],
    resource: env.YNM_PUBLIC_URL?.trim() || cfg.audience,
    scopesSupported: scopes?.length ? scopes : undefined,
  };
}
