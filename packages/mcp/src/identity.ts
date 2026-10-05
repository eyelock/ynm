import type { AuthInfo } from "@modelcontextprotocol/server";
import type { Login } from "@ynm/model";
import { clientActor, STATIC_TOKEN_ACTOR, type Ynm } from "@ynm/service";
import { Auditor, type AuditSink, auditSinkFromEnv } from "./audit.js";
import { clientIdOf, isStaticToken } from "./auth.js";

/**
 * The login a verified token vouches for (ADR-017): its issuer and subject. A shared static token
 * vouches for no one, so it has none.
 */
export function loginOf(info: AuthInfo | undefined): Login | undefined {
  const sub = info?.extra?.sub;
  const iss = info?.extra?.iss;
  return typeof sub === "string" && sub && typeof iss === "string" && iss
    ? { issuer: iss, subject: sub }
    : undefined;
}

/**
 * A signed-in person's handle in telemetry (ADR-018): their sign-in id, the token's subject,
 * qualified by the identity provider's host, as in `idp.example.com/alice`. Never a name or an
 * email: a subject that is an email address gives no handle, and no other claim is read.
 */
export function handleOf(info: AuthInfo | undefined): string | undefined {
  const login = loginOf(info);
  if (!login || login.subject.includes("@")) return undefined;
  let host = login.issuer;
  try {
    host = new URL(login.issuer).host || login.issuer;
  } catch {}
  return `${host}/${login.subject}`;
}

/**
 * Who a verified request that vouches for no person writes as (ADR-017): the shared static token,
 * else the client an identity provider's token names, else nobody, so the server's own actor.
 */
export function sharedActorOf(info: AuthInfo | undefined): string | undefined {
  if (isStaticToken(info)) return STATIC_TOKEN_ACTOR;
  const client = clientIdOf(info);
  return client ? clientActor(client) : undefined;
}

/**
 * The store as the request's signed-in person sees it; as a caller who is no person sees it, whose
 * writes are recorded as `token:static` or `client:<id>`; or as it is when nobody signed in
 * (stdio, `--no-auth`) or a token names neither a subject nor a client.
 */
export async function storeFor(ynm: Ynm, info: AuthInfo | undefined): Promise<Ynm> {
  const login = loginOf(info);
  if (login) return ynm.as({ person: await ynm.personFor(login), client: info?.clientId, login });
  const shared = sharedActorOf(info);
  return shared ? ynm.asShared(shared) : ynm;
}

/**
 * Audit and identity for a hosted server (ADR-017), from `YNM_AUDIT`. The sink is resolved once,
 * after the store opens, so an s3 sink can default to the store's own bucket; a bad setting is
 * reported on stderr and audit stays off rather than failing every request.
 */
export function hostedAudit(
  env: NodeJS.ProcessEnv,
  authenticated: boolean,
  getYnm: () => Promise<Ynm>
): { audit?: Auditor; identify: (info: AuthInfo | undefined) => Promise<string | undefined> } {
  const identify = async (info: AuthInfo | undefined) => {
    const login = loginOf(info);
    return login ? (await getYnm()).personFor(login) : undefined;
  };
  if (auditOff(env, authenticated)) return { identify };
  const resolved = (async () => {
    const ynm = await getYnm().catch(() => undefined);
    const log = ynm?.mounts.map((m) => m.log).find((l) => l.provider === "s3") as
      | { bucket?: string; prefix?: string }
      | undefined;
    const s3Store = log?.bucket
      ? { bucket: log.bucket, prefix: log.prefix ?? "", region: env.AWS_REGION }
      : undefined;
    return auditSinkFromEnv(env, { authenticated, s3Store });
  })().catch((err: unknown) => {
    console.error(`[ynm-mcp audit] off: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
  const sink: AuditSink = {
    write: async (event, context) => (await resolved)?.write(event, context),
  };
  return { audit: new Auditor(sink), identify };
}

/** Whether audit is plainly off, so requests need not be buffered for it. */
function auditOff(env: NodeJS.ProcessEnv, authenticated: boolean): boolean {
  const raw = env.YNM_AUDIT?.trim();
  if (!raw) return !authenticated;
  try {
    return (JSON.parse(raw) as { sink?: unknown }).sink === "off";
  } catch {
    return false; // auditSinkFromEnv reports the bad setting
  }
}
