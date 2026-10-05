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
- **A shared token has no identity.** Everyone who holds the token is the same caller, so a distributed
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

`resource` defaults to `YNM_PUBLIC_URL`, which a hosted server already requires, so the URL is set
once. The auth object never holds a secret.

**Environment.** A server configured by environment alone (a container or a function) uses three
ordinary environment variables, so a secret store that loads variables at start, such as Parameter
Store for a function, needs no extra work:

| Variable | Holds |
|---|---|
| `YNM_AUTH` | the `auth` object above, as JSON (as `YNM_MOUNTS` holds `mounts`) |
| `YNM_AUTH_CLIENT_SECRET` | the client secret, for `introspection` and any preset that needs a confidential client |
| `YNM_AUDIT` | the `audit` object (below), as JSON |

**The old variables, for one release.** `YNM_JWKS_URL` maps onto `oidc` and
`YNM_OAUTH_INTROSPECTION_URL` onto `introspection`, each with a deprecation line. `YNM_MCP_TOKEN`
maps onto `local-token` on loopback. Off loopback it runs as a deprecated `bearer` provider: it
starts, warns at start and on `/health`, and its `Principal` is one fixed `bearer/shared` identity,
which is what a shared token has always been. The release after that refuses a static token off
loopback, so a hosted store moves to a real provider within one release instead of on the day this
ships.

**`/health` reports the mode** as `auth`, so a deploy guard can refuse a store that is not
protected:

| `auth` | When |
|---|---|
| `none` | `--no-auth`, loopback only |
| `local-token` | the generated local token, loopback only |
| `bearer` | a static token off loopback, with `"deprecated": true`, for one release |
| `oidc` | an OpenID Connect provider, with or without a preset |
| `introspection` | an RFC 7662 introspection endpoint |

### The server is never open by accident

- `ynm serve --http` always runs an `AuthProvider`. With nothing configured on a loopback address
  it uses `local-token`: a random token generated on first start into `~/.ynm/serve-token` (mode
  600), printed once, rotated with `ynm serve token --rotate`. `ynm client install <client> --http
  <url>` reads that file for a local URL and writes the bearer header, so local use stays
  zero-configuration (NFR-14).
- A server reachable from outside the machine refuses to start unless a provider other than
  `local-token` is configured (or, for one release, a deprecated static token), and says which
  settings are missing. Reachable means a non-loopback bind address (`--host 0.0.0.0` or any
  routable address) or running as a function (ADR-009): a function is always treated as public,
  whatever its URL. The Docker image follows the same rule.
- `--no-auth` exists for tests and demos and is refused when reachable. It replaces the function's
  own escape hatch (`YNM_LAMBDA_ALLOW_OPEN`), so there is one rule and one override for every way
  ynm is served.

### Identity reaches everything through the `Principal`

- **Authorship.** Each request's `Principal` becomes the provenance of what it writes: `actor`
  is `user:<issuer-host>/<subject>` with email and client ID recorded beside it. `ynm list`,
  recall results, review queues and the wiki show the person, not the server.
- **Where a person's memory goes on a distributed store.** A hosted store is distributed (ADR-007):
  it is the team's. The personal level stays on each person's own machine and is never served
  over HTTP. Writes that do not name a namespace default to `user/<subject>` within the distributed
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
- Sinks, configured by the `audit` object (`{ "sink": "file" | "stdout" | "s3", … }`):
  - **file:** JSONL (`--audit-log <path>`, rotated by size).
  - **stdout:** for container and function log pipelines. It is the first sink for a function,
    whose local disk does not outlive the instance; there, audit events share the function's log
    stream and its retention.
  - **s3:** follows stdout, reusing the S3 record log's client. One object per request at
    `<prefix>/<yyyy>/<mm>/<dd>/<ulid>.json`, written with the same conditional put. `bucket`
    defaults to the store's bucket when the store is on S3 and is required otherwise; `prefix`
    defaults to `audit/<store prefix>`. Audit therefore never sits under a store prefix, so a
    retention rule on it cannot expire memory. Date folders let one lifecycle rule set retention
    and let `ynm audit` read only the days a time filter asks for. The writer needs only
    `s3:PutObject` on that prefix; `ynm audit` needs `s3:ListBucket` and `s3:GetObject`.

  The same seam takes an OpenTelemetry or SIEM sink later. Audit is on by default for any
  provider other than `local-token`.
- `ynm audit` reads a JSONL audit log or an S3 audit prefix: filter by subject, email, tool,
  status and time; `--json` for scripts. It does not read a cloud provider's log service; stdout
  audit is read with that service's own tools.
- The audit log records requests; the git notes log (NFR-4) remains the durable record of every
  change to memory, now attributed to a person. The two answer different questions: who asked
  for what, and what is in the store and who put it there.

### Proof

- A local Keycloak (`infra/keycloak`, `make keycloak`) is the reference identity provider for
  development and tests: a ready-made realm with two users, the memory scopes, the MCP URL as
  audience, a PKCE client, an introspection client and anonymous client registration.
  `make keycloak-check` proves the realm offers each of those before any ynm code relies on it.
- A conformance suite for `AuthProvider` (valid token, expired, wrong audience, wrong issuer,
  missing scope, metadata document, challenge header) run against `local-token`, `oidc` with
  that Keycloak, and `introspection` with a stub.
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
- ADR-009's hosting decision is amended: its auth section moves here, and the function's
  refusal to start without auth becomes this ADR's reachability rule.
- Auth and audit run in the one request handler that both `ynm serve --http` and the function
  call, so the 401 challenge, the metadata document, token checks, scope checks and audit behave
  the same on both.
- A hosted store on a static token keeps working for one release after this ships, with a
  warning, and must move to a real provider before the next.
- With hosted writes defaulting to the distributed level, the instructions a hosted server sends
  name the `user/<subject>` namespace default, so agents know where unnamed writes land.

## History

- 2026-09-30: proposed after the first hosted use showed an open-by-default server and no
  per-user identity or audit.
- 2026-10-01: revised for running as a function: one reachability rule covering functions,
  a one-release deprecation window for static tokens off loopback, `/health` auth modes, the
  `YNM_AUTH`, `YNM_AUTH_CLIENT_SECRET` and `YNM_AUDIT` variables, and an S3 audit sink after
  stdout. Still proposed.
- 2026-10-02: the discovery half built first, so clients can sign in before the provider seam
  exists: the metadata document and the challenge's `resource_metadata`, driven by the existing
  JWT variables (`YNM_JWT_ISSUER` as the authorization server, `YNM_PUBLIC_URL` or the audience as
  the resource). These move into `YNM_AUTH` with the seam. Still proposed.
- 2026-10-03: the identity and audit half built, with these changes to the design above. Still
  proposed.
  - **A ynm person id between the identity provider and the records.** A login (issuer and
    subject) resolves to a person id, `p` plus 16 base32 characters of a hash of the login, so
    it exists without a write. Records carry `actor: user:<person id>` and the OAuth client as
    `provenance.client`; unnamed hosted writes go to `user/<person id>`. Neither the subject nor
    any email reaches a record, and moving to another identity provider does not split a person:
    `ynm people link` attaches the new login to the existing person id.
  - **No email.** It is personal data that append-only, replicated records cannot easily shed,
    and the person id makes it unnecessary; no claim beyond `iss` and `sub` is read.
  - **Nicknames, not names.** A `people` document beside the record log (ADR-004) maps person ids
    to the nickname each person sets for themselves (`memory_people`) and to their linked
    logins. Listings, recall, the review queue and the wiki show the nickname, else the person id.
    Concurrent edits on git-notes clones merge per person, newer entry winning, logins combined.
  - **Audit is metadata only.** Each event holds when, the person id and client, method, path,
    status and outcome, the refusal's error code, the tools called with the memory ids they
    touched, input size and result count, and the duration; never tool inputs or content. Only
    requests that reach the MCP handler, and refusals, are audited. Sinks are stdout, a rotated
    JSONL file and S3, chosen by `YNM_AUDIT`; unset, stdout when the server checks tokens.
  - Not yet built: `ynm audit`, the `YNM_AUTH` configuration and provider presets, and the single
    reachability rule with `--no-auth`. A shared static token still vouches for no one, so its
    writes keep the server's actor.
- 2026-10-04: a static token's writes are recorded as `actor: token:static`, not the server's
  actor, which made every shared-token write look like the server's own user. The token is still
  one shared identity for everyone holding it (the fixed identity the decision above calls
  `bearer/shared`): no person id, `memory_people` refuses with an
  explanation, and its audit events carry client `static` with no person. Per-person identity
  needs an identity provider, with machine tokens from the client credentials grant for workers
  and CI. Named tokens or a token-holder option were rejected as a second, weaker identity system.
  Writes the server makes itself, such as scheduled dream runs, keep the server's actor. Still
  proposed.
- 2026-10-04: an identity provider's token with no `sub` but a client id (JWT `azp` or
  `client_id`, introspection `client_id`) has its writes recorded as `actor: client:<client id>`,
  not the server's actor. Like the static token it is a shared identity with no person id: an
  unnamed write goes to `common`, `memory_people` refuses because the token has no subject to
  identify a person, readers show no author, and audit events carry that client with no person.
  Only a token with neither a subject nor a client id keeps the server's actor. The static token's
  view became one general view carrying a fixed shared actor, so the store still chooses a write's
  actor in one place. Refusing such writes was rejected because client-credentials tokens without
  `sub` are legitimate, and documenting the gap alone left the records misleading. Still proposed.
- 2026-10-05: one exception to "no claim beyond `iss` and `sub` is read", for telemetry only.
  The verifiers also carry the token's `preferred_username` (or introspection's `username`), and
  the OpenTelemetry handle reads it (ADR-018), because a provider's `sub` can be an opaque id.
  Nothing in this ADR's identity reads it: the person id, actors, provenance, `memory_people` and
  the stdout, file and s3 audit sinks are still keyed by issuer and subject alone. Still proposed.
