# ADR-017: Authentication, identity and audit for the HTTP server

Status: proposed (2026-09-30)
Satisfies: NFR-4, NFR-5, NFR-11, NFR-12, NFR-14

## Context

`ynm serve --http` (ADR-009) authenticates from the environment: a JWT verified against a JWKS,
RFC 7662 token introspection, a shared static bearer token, or, with none of those set, nothing.
Three gaps showed up once the hosted service was used in anger:

- **It can run open.** With no auth configured the server accepts every request. Bound to
  `localhost` that exposes a user's memory to every local process; bound to `0.0.0.0`, which the
  Docker image does by default, it exposes it to the network.
- **A shared token has no identity.** Everyone who holds the token is the same caller, so a shared
  store cannot say who wrote a memory, who read what, or refuse one user without refusing all.
  Every memory a hosted server writes carries the server's own `actor`, not the person's.
- **Clients cannot sign users in.** MCP's authorization for HTTP transports is OAuth 2.1: the MCP
  server is a *resource server* that publishes Protected Resource Metadata (RFC 9728) naming its
  authorization servers, answers an unauthenticated request with `401` and a `WWW-Authenticate`
  header pointing at that metadata, and accepts only tokens issued for its own URL (the resource
  indicator, RFC 8707). Clients such as Claude Code and Copilot CLI then discover the identity
  provider, obtain a client ID, run the authorization-code flow with PKCE in the user's browser,
  and send the resulting token. ynm has the verification half (JWKS, introspection) but not the
  discovery half, so no client can start that flow against it.

Identity providers differ exactly where this flow touches them: how discovery works, whether
clients can register themselves (RFC 7591 dynamic client registration: Keycloak and Auth0 yes,
Okta and Entra generally no), how the audience is expressed (Auth0's `audience` parameter,
Entra's application ID URIs, Google's lack of custom audiences), and which claims name the person.
Supporting one provider well and the rest by accident is the failure to avoid.

## Decision

### One seam: `AuthProvider`

Authentication is a seam, like the store (ADR-004), the index (ADR-005) and the model seams
(ADR-012): one interface, several providers, one conformance suite.

```ts
interface AuthProvider {
  readonly name: string;
  /** What the 401 challenge and /.well-known/oauth-protected-resource advertise. */
  metadata(): ResourceMetadata; // authorization_servers, scopes_supported, resource
  /** A bearer token becomes a person, or the request is refused (401 invalid_token). */
  verify(token: string): Promise<Principal>;
  /** How a client obtains a client ID from this provider. */
  registration(): ClientRegistration; // "dynamic" | "metadata-document" | { preRegistered: clientId }
}

interface Principal {
  subject: string;        // stable identifier from the issuer (`sub`)
  issuer: string;
  email?: string;
  name?: string;
  clientId: string;       // which agent client acted for the person
  scopes: string[];
  expiresAt: number;
}
```

Providers:

| Provider | Use | Principal |
|---|---|---|
| `local-token` | One person on their own machine | the machine's user, from config |
| `oidc` | Any OpenID Connect provider, from its issuer URL alone: discovery (`/.well-known/openid-configuration`) supplies the JWKS, endpoints and registration support | from the token's `sub`, `email`, `name` |
| `introspection` | Providers that issue opaque tokens (RFC 7662), the existing verifier moved behind the seam | from the introspection response |

**Presets** sit on top of `oidc` and carry each provider's quirks as data, not code: Keycloak,
Auth0 (the `audience` parameter), Okta (authorization-server paths), Entra (issuer format,
application ID URI audiences, pre-registered clients) and Google (ID-token audiences). A new
provider is a new preset. Configuration names the provider and its few values:

```json
{ "auth": { "provider": "oidc", "preset": "keycloak",
            "issuer": "https://idp.example.com/realms/eng",
            "resource": "https://memory.example.com/mcp",
            "scopes": { "read": "memory:read", "write": "memory:write" } } }
```

Environment variables keep working for containers (`YNM_AUTH_PROVIDER`, `YNM_OAUTH_ISSUER`,
`YNM_PUBLIC_URL`, …); the old `YNM_JWKS_URL`, `YNM_OAUTH_INTROSPECTION_URL` and `YNM_MCP_TOKEN`
map onto `oidc` and `introspection` and `local-token` for one release, with a deprecation line.

### The server is never open by accident

- `ynm serve --http` always runs an `AuthProvider`. With nothing configured on a loopback address
  it uses `local-token`: a random token generated on first start into `~/.ynm/serve-token` (mode
  600), printed once, rotated with `ynm serve token --rotate`. `ynm client install <client> --http
  <url>` reads that file for a local URL and writes the bearer header, so local use stays
  zero-configuration (NFR-14).
- On a non-loopback address (`--host 0.0.0.0` or any routable address) the server refuses to
  start unless a provider other than `local-token` is configured, and says which settings are
  missing. The Docker image follows the same rule.
- `--no-auth` exists for tests and demos and is refused on a non-loopback address.

### Identity reaches everything through the `Principal`

- **Authorship.** Each request's `Principal` becomes the provenance of what it writes: `actor`
  is `user:<issuer-host>/<subject>` with email and client ID recorded beside it. `ynm list`,
  recall results, review queues and the wiki show the person, not the server.
- **Where a person's memory goes on a shared store.** A hosted store is distributed (ADR-007):
  it is the team's. The personal level stays on each person's own machine and is never served
  over HTTP. Writes that do not name a namespace default to `user/<subject>` within the shared
  store, so a person's working notes are attributable and filterable without being private.
- **Authorisation.** Scopes gate tools: `memory:read` for recall, context, status and the
  read-only resources; `memory:write` for everything that appends. A missing scope is a `403
  insufficient_scope` naming the scope. Namespace-level rules are left for a later ADR.
- The `Principal` travels with the request (NFR-11); nothing about a caller is cached between
  requests except verified-token results for their remaining lifetime.

### Audit: an `AuditSink` seam

Every HTTP request produces one audit event, whether it succeeded, failed or was refused:

```json
{ "at": "2026-10-01T09:14:03.120Z", "subject": "keycloak/8f1c…", "email": "alice@example.com",
  "clientId": "claude-code", "tool": "memory_recall", "input": { "text": "release gate" },
  "result": { "memoryIds": ["01M…", "01M…"] }, "status": "ok", "durationMs": 23 }
```

- Inputs are recorded as the tool received them after the redaction patterns run over string
  values (ADR-007), so a secret pasted into a query is not written to the audit log either.
- Refusals (401, 403) are recorded with the reason and whatever identity was presented.
- Sinks: JSONL file (`--audit-log <path>`, rotated by size) and stdout (for container log
  pipelines), with the same seam available to an OpenTelemetry or SIEM sink later. Audit is on by
  default for any provider other than `local-token`.
- `ynm audit` reads a JSONL audit log: filter by subject, email, tool, status and time;
  `--json` for scripts.
- The audit log records requests; the git notes log (NFR-4) remains the durable record of every
  change to memory, now attributed to a person. The two answer different questions: who asked
  for what, and what is in the store and who put it there.

### Proof

- A conformance suite for `AuthProvider` (valid token, expired, wrong audience, wrong issuer,
  missing scope, metadata document, challenge header) run against `local-token`, `oidc` with a
  Keycloak container, and `introspection` with a stub.
- Each preset tested against a recorded discovery document and example tokens for that provider,
  so presets are verified without accounts at every provider.
- An end-to-end test: Keycloak in Docker, two users, an MCP client that follows the 401 challenge
  and discovery, writes and reads as each user; the audit log and the memories' provenance must
  attribute every action to the right person.
- Docs: tutorial 10 rewritten around sign-in with Keycloak, a how-to per preset
  ("Run a shared ynm with Okta sign-in", …), and the configuration reference.

## Not decided here

- Namespace-level access control (who may write `org/eyelock/project/x`).
- Per-user rate limits.
- Being an authorization server ourselves: ynm delegates sign-in to an identity provider and does
  not issue tokens beyond the local one.

## Alternatives considered

- **Keep shared tokens, add a user header.** A header the client sets is a claim, not an identity;
  any holder of the token can set any name. Rejected.
- **One code path per identity provider.** Faster to start, but every provider's quirks leak into
  the server and a new provider means new code. Presets over a single `oidc` provider keep the
  quirks as data.
- **Built-in user accounts.** A second identity system for teams that already have one, plus
  password storage to secure. Rejected in favour of delegating to their identity provider.
- **Audit in the git notes log.** Reads would become writes and the store would grow with every
  query. The notes log keeps the changes; a separate sink keeps the requests.

## Consequences

- A hosted ynm needs an identity provider to be reachable from the network. That is the point, but
  the Docker quick start changes: the demo gains a Keycloak service.
- Client support varies: a client without MCP OAuth support can still use a token obtained out of
  band (`ynm serve token` for local, a provider-issued token for hosted).
- Provenance gains fields; existing records keep their server-level actor.
- ADR-009's hosting decision is amended: its auth section moves here.

## History

- 2026-09-30: proposed after the first hosted use showed an open-by-default server and no
  per-user identity or audit.
