import type { ContextBlock } from "@ynm/index";
import type { ConsolidateInput, SessionEndInput, SessionStartInput } from "@ynm/model";
import {
  ConsolidateInputSchema,
  normalizeSessionId,
  SessionEndInputSchema,
  SessionStartInputSchema,
  sessionNamespace,
  ulid,
} from "@ynm/model";
import type { Ynm } from "./ynm.js";

/** ISO 8601 duration to milliseconds; enough for the TTL shapes the schema allows. */
export function durationMs(iso: string): number {
  const m =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
      iso
    );
  if (!m) throw new Error(`bad duration ${iso}`);
  const [, y, mo, w, d, h, mi, s] = m.map((x) => (x ? Number(x) : 0));
  return (
    (((y ?? 0) * 365 + (mo ?? 0) * 30 + (w ?? 0) * 7 + (d ?? 0)) * 24 * 3600 +
      (h ?? 0) * 3600 +
      (mi ?? 0) * 60 +
      (s ?? 0)) *
    1000
  );
}

export interface SessionStartResult {
  sessionId: string;
  namespace: string;
  ttl: string;
  context: ContextBlock;
}

export interface ConsolidateReport {
  dryRun: boolean;
  passes: Record<string, { candidates: number; changed: string[] }>;
}

/** Session lifecycle and the no-model consolidation passes available before M4 (ADR-006). */
export class Lifecycle {
  constructor(
    private readonly ynm: Ynm,
    private readonly now: () => Date = () => new Date()
  ) {}

  async start(raw: SessionStartInput | Record<string, unknown>): Promise<SessionStartResult> {
    const input = SessionStartInputSchema.parse(raw);
    const sessionId = normalizeSessionId(input.sessionId ?? ulid());
    const context = await this.ynm.context({
      namespace: input.namespace,
      budgetTokens: input.budgetTokens,
    });
    return { sessionId, namespace: sessionNamespace(sessionId), ttl: input.ttl, context };
  }

  async end(
    raw: SessionEndInput | Record<string, unknown>
  ): Promise<{ sessionId: string; expired: string[] }> {
    const input = SessionEndInputSchema.parse(raw);
    const expired = input.expire
      ? ((
          await this.consolidate({
            passes: ["expire"],
            namespace: sessionNamespace(input.sessionId),
          })
        ).passes.expire?.changed ?? [])
      : [];
    return { sessionId: input.sessionId, expired };
  }

  /** Tombstones working memories whose ttl has elapsed (ADR-006, pass 1). */
  async consolidate(raw: ConsolidateInput | Record<string, unknown>): Promise<ConsolidateReport> {
    const input = ConsolidateInputSchema.parse(raw);
    const report: ConsolidateReport = { dryRun: input.dryRun, passes: {} };
    if (input.passes.includes("expire")) {
      const changed: string[] = [];
      let candidates = 0;
      const now = this.now().getTime();
      for (const m of await this.ynm.list({
        type: "working",
        namespace: input.namespace,
        includeTombstoned: false,
      })) {
        const ttl = m.current.ttl;
        if (!ttl) continue;
        candidates += 1;
        if (Date.parse(m.updatedAt) + durationMs(ttl) <= now) {
          if (!input.dryRun) await this.ynm.forget({ memoryId: m.memoryId, reason: "expired" });
          changed.push(m.memoryId);
        }
      }
      report.passes.expire = { candidates, changed };
    }
    return report;
  }
}
