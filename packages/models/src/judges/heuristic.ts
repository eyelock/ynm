import {
  type Answer,
  estimateTokens,
  type JsonValue,
  type Judge,
  type JudgeLimits,
  type Judgment,
  type Question,
} from "../types.js";

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t.length > 2)
  );
}

export function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

const NEGATIONS =
  /\b(not|never|no longer|isn't|aren't|doesn't|don't|won't|cannot|can't|isnt|dont)\b/;

function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object")
    return Object.values(v as Record<string, unknown>)
      .map(text)
      .join(" ");
  return "";
}

function field(state: JsonValue, key: string): unknown {
  return state && typeof state === "object" && !Array.isArray(state)
    ? (state as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The no-model fallback (ADR-012). It understands only the question ids the dream passes use,
 * computed from well-known state fields (`a`, `b`, `memory`, `summary`, `sources`). Anything
 * else gets an honest "don't know": noul 0.5, uniform choice, mid score.
 */
export class HeuristicJudge implements Judge {
  readonly name = "heuristic";
  readonly calibrated = false;

  limits(): JudgeLimits {
    return { stateTokens: 1_000_000, requestTokens: 1_000_000, maxChoices: 255 };
  }

  async judge<Q extends Record<string, Question>>(
    state: JsonValue,
    questions: Q
  ): Promise<Judgment<Q>> {
    const a = text(field(state, "a"));
    const b = text(field(state, "b"));
    const sim = jaccard(a, b);
    const answers = {} as { [K in keyof Q]: Answer };
    for (const [id, q] of Object.entries(questions) as Array<[keyof Q, Question]>) {
      answers[id] = this.answer(String(id), q, { a, b, sim, state });
    }
    return {
      answers,
      model: "heuristic",
      calibrated: false,
      usage: { inputTokens: estimateTokens(state), outputTokens: 0 },
    };
  }

  private answer(
    id: string,
    q: Question,
    ctx: { a: string; b: string; sim: number; state: JsonValue }
  ): Answer {
    const noul = (p: number): Answer => ({ type: "noul", noul: Math.max(0, Math.min(1, p)) });
    switch (q.type) {
      case "noul":
        switch (id) {
          case "sameFact":
            return noul(ctx.sim);
          case "sameSubject":
            return noul(ctx.sim > 0.15 ? 0.8 : 0.2);
          case "contradicts": {
            const na = NEGATIONS.test(ctx.a);
            const nb = NEGATIONS.test(ctx.b);
            return noul(ctx.sim > 0.4 && na !== nb ? 0.8 : 0.1);
          }
          case "newerSupersedes":
            return noul(0.5);
          case "usefulLater": {
            const m = text(field(ctx.state, "memory"));
            return noul(
              /\b(always|never|prefer|decid|convention|rule|because|deploy|release)\b/i.test(m)
                ? 0.7
                : 0.3
            );
          }
          case "unsupported":
          case "lostFact":
          case "wrongDate": {
            const summary = text(field(ctx.state, "summary"));
            const sources = text(field(ctx.state, "sources"));
            const overlap = jaccard(summary, sources);
            return noul(
              id === "lostFact" ? (overlap < 0.2 ? 0.7 : 0.2) : overlap < 0.1 ? 0.7 : 0.15
            );
          }
          case "sensitive": {
            const m = text(field(ctx.state, "memory"));
            return noul(
              /\b(password|secret|token|api[_ -]?key|ssn|credit card)\b/i.test(m) ? 0.9 : 0.05
            );
          }
          default:
            return noul(0.5);
        }
      case "choice": {
        const keys = Object.keys(q.criteria);
        const p = 1 / Math.max(keys.length, 1);
        return {
          type: "choice",
          choice: keys[0] ?? "",
          probabilities: Object.fromEntries(keys.map((k) => [k, p])),
          confidence: 0,
        };
      }
      case "score": {
        const n = q.criteria.length;
        if (id === "relation") {
          // 0 different, 1 related, 2 same
          const s = ctx.sim > 0.6 ? 2 : ctx.sim > 0.2 ? 1 : 0;
          const probabilities = {
            "0": s === 0 ? 0.8 : 0.1,
            "1": s === 1 ? 0.8 : 0.1,
            "2": s === 2 ? 0.8 : 0.1,
          };
          return {
            type: "score",
            score: s,
            legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), String(c)])),
            probabilities,
            confidence: 0.6,
          };
        }
        if (id === "importance") {
          const m = text(field(ctx.state, "memory"));
          const s = Math.min(
            n - 1,
            Math.round(
              (/\b(always|never|must|critical|decid|convention)\b/i.test(m) ? 0.7 : 0.4) * (n - 1)
            )
          );
          return {
            type: "score",
            score: s,
            legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), String(c)])),
            probabilities: { [String(s)]: 0.6 },
            confidence: 0.3,
          };
        }
        const mid = Math.floor((n - 1) / 2);
        return {
          type: "score",
          score: mid,
          legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), String(c)])),
          probabilities: { [String(mid)]: 1 / n },
          confidence: 0,
        };
      }
    }
  }
}
