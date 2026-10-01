#!/usr/bin/env node
// Helper for the local Keycloak in this directory. No dependencies beyond Node.
//   node infra/keycloak/keycloak.mjs wait            wait until the ynm realm answers
//   node infra/keycloak/keycloak.mjs token <user> [scopes]
//                                                     print an access token (default scopes:
//                                                     "memory:read memory:write")
//   node infra/keycloak/keycloak.mjs check           prove the realm gives ynm what it needs
const ISSUER = process.env.KEYCLOAK_ISSUER ?? "http://localhost:8180/realms/ynm";
const RESOURCE = process.env.KEYCLOAK_AUDIENCE ?? "http://localhost:3000/mcp";
const CLIENT = "ynm-cli";

const discovery = async () => {
  const res = await fetch(`${ISSUER}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`discovery ${res.status}`);
  return res.json();
};

async function token(user, scopes = "memory:read memory:write") {
  const { token_endpoint } = await discovery();
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // Password grant: for scripted local tests only. Real clients use the browser flow.
    body: new URLSearchParams({
      grant_type: "password",
      client_id: CLIENT,
      username: user,
      password: user,
      scope: `openid ${scopes}`.trim(),
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token for ${user}: ${body.error_description ?? body.error}`);
  return body.access_token;
}

const claims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

async function wait() {
  const until = Date.now() + 180_000;
  for (;;) {
    try {
      await discovery();
      console.log(`keycloak ready: ${ISSUER}`);
      return;
    } catch {
      if (Date.now() > until) throw new Error(`keycloak did not answer at ${ISSUER} within 3 minutes`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function check() {
  let failed = 0;
  const line = (ok, what, detail) => {
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `: ${detail}` : ""}`);
  };
  const d = await discovery();
  line(d.issuer === ISSUER, "issuer", d.issuer);
  line(Boolean(d.jwks_uri), "signing keys published", d.jwks_uri);
  line(Boolean(d.registration_endpoint), "clients can register themselves", d.registration_endpoint);
  line((d.code_challenge_methods_supported ?? []).includes("S256"), "PKCE S256 supported");
  const keys = await (await fetch(d.jwks_uri)).json();
  line(keys.keys?.length > 0, "signing keys", `${keys.keys?.length ?? 0} key(s)`);

  const a = claims(await token("alice"));
  const aud = [a.aud].flat();
  line(aud.includes(RESOURCE), "token audience is the ynm MCP URL", aud.join(", "));
  line(a.iss === ISSUER, "token issuer", a.iss);
  line(Boolean(a.sub), "token names the person (sub)", a.sub);
  line(a.email === "alice@example.com", "token carries email", a.email);
  line(a.name === "Alice Example", "token carries name", a.name);
  line(a.azp === CLIENT, "token names the client (azp)", a.azp);
  const aScopes = a.scope.split(" ");
  line(aScopes.includes("memory:read") && aScopes.includes("memory:write"), "alice: read and write scopes", a.scope);

  const b = claims(await token("bob", "memory:read"));
  const bScopes = b.scope.split(" ");
  line(bScopes.includes("memory:read") && !bScopes.includes("memory:write"), "bob asking for read only gets no write scope", b.scope);
  line(b.sub !== a.sub, "alice and bob are different people");

  const reg = await fetch(d.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ynm check",
      redirect_uris: ["http://127.0.0.1:33418/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "memory:read memory:write",
    }),
  });
  const client = await reg.json();
  line(reg.status === 201 && Boolean(client.client_id), "a client registers itself without an account (RFC 7591)", client.client_id ?? `${reg.status} ${client.error_description ?? client.error}`);
  if (client.registration_access_token && client.registration_client_uri)
    await fetch(client.registration_client_uri, {
      method: "DELETE",
      headers: { authorization: `Bearer ${client.registration_access_token}` },
    });

  if (failed) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nkeycloak gives ynm everything sign-in needs");
}

const [cmd, ...args] = process.argv.slice(2);
const run = { wait, check, token: async () => console.log(await token(args[0] ?? "alice", args[1])) }[cmd];
if (!run) {
  console.error("usage: keycloak.mjs wait | check | token <user> [scopes]");
  process.exit(2);
}
run().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
