import { normalizeSessionId } from "@ynm/model";
import { Lifecycle } from "../lifecycle.js";
import type { Ynm } from "../ynm.js";
import { type HookInput, type HookOutput, hookContext, SESSION_START_PREFIX } from "./intent.js";

export * from "./intent.js";

/** Session start: the context block with the default budget, prefixed with how to use it. */
export async function sessionStartHook(ynm: Ynm, input: HookInput): Promise<HookOutput> {
  const s = await new Lifecycle(ynm).start({
    sessionId: input.session_id ? normalizeSessionId(input.session_id) : undefined,
  });
  const body = s.context.markdown.trim();
  return hookContext(
    "session-start",
    body ? `${SESSION_START_PREFIX}\n\n${body}` : SESSION_START_PREFIX
  );
}

/**
 * Stop: ends the ynm session for the client's session id, which expires its due working memory.
 * Claude Code fires Stop every turn, so this is the expire pass alone (never the model-backed
 * engine), idempotent, and a no-op when nothing is due.
 */
export async function stopHook(ynm: Ynm, input: HookInput): Promise<HookOutput> {
  if (input.session_id) await new Lifecycle(ynm).expireSession(input.session_id);
  return {};
}
