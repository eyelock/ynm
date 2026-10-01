# Local Keycloak

A local identity provider for building and testing sign-in to `ynm serve --http`. It runs
Keycloak in Docker with a realm named `ynm` that is already set up the way ynm needs, so there
is nothing to click through in an admin console. It is for development only: plain HTTP, fixed
passwords, and an `admin`/`admin` console login.

```sh
make keycloak          # start it and wait until it answers
make keycloak-check    # prove it gives ynm what sign-in needs
make keycloak-token    # print an access token for alice
make keycloak-down     # stop it and throw its data away
```

`make keycloak-token U=bob S=memory:read` prints a token for bob with read access only.

## What the realm contains

| Thing | Value |
|---|---|
| Issuer | `http://localhost:8180/realms/ynm` |
| Users | `alice` / `alice` and `bob` / `bob`, with emails `alice@example.com` and `bob@example.com` |
| Scopes | `memory:read` and `memory:write`, granted only when a client asks for them |
| Audience | every token names `http://localhost:3000/mcp`, the default address of `ynm serve --http` |
| `ynm-cli` | a public client with PKCE for the browser flow; it also allows the password grant, so scripts and tests can get a token without a browser |
| `ynm-server` | a confidential client with secret `ynm-dev-secret`, for token introspection |
| Client registration | any client on this machine can register itself, the way MCP clients such as Claude Code do on first connect |
| Admin console | `http://localhost:8180/admin`, `admin` / `admin` |

The realm is defined in [`realm-ynm.json`](realm-ynm.json) and imported every time the
container starts, so `make keycloak-down` followed by `make keycloak` always gives a clean realm.
To serve ynm on a different address, change the audience in that file and set
`KEYCLOAK_AUDIENCE` to the same address when running `keycloak.mjs`.

`make keycloak-check` checks each of these against the running server: discovery, signing keys,
PKCE, self-registration, and a token's issuer, audience, subject, email, name, client and
scopes for each user.
