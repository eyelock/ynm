import type { AuthInfo } from "@modelcontextprotocol/server";
import type { Login } from "@ynm/model";
import type { Ynm } from "@ynm/service";
import { Auditor, type AuditSink, auditSinkFromEnv } from "./audit.js";
import { isStaticToken } from "./auth.js";

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
 * The store as the request's signed-in person sees it; as the shared static token sees it, whose
 * writes are recorded as `token:static`; or as it is when nobody signed in (stdio, `--no-auth`).
 */
export async function storeFor(ynm: Ynm, info: AuthInfo | undefined): Promise<Ynm> {
  const login = loginOf(info);
  if (!login) return isStaticToken(info) ? ynm.asStaticToken() : ynm;
  return ynm.as({ person: await ynm.personFor(login), client: info?.clientId, login });
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
  const sink: AuditSink = { write: async (event) => (await resolved)?.write(event) };
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
