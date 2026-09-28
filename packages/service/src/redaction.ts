export interface RedactionHit {
  pattern: string;
  sample: string;
}

export class RedactionError extends Error {
  constructor(readonly hits: RedactionHit[]) {
    super(
      `content matches ${hits.length} redaction pattern${hits.length === 1 ? "" : "s"}: ${hits.map((h) => h.pattern).join(", ")}`
    );
    this.name = "RedactionError";
  }
}

function compile(pattern: string): RegExp {
  const m = /^\(\?i\)(.*)$/.exec(pattern);
  return m ? new RegExp(m[1] as string, "i") : new RegExp(pattern);
}

/** Finds pattern hits in text. Distributed writes are refused, not silently altered (ADR-007). */
export function findRedactions(text: string, patterns: readonly string[]): RedactionHit[] {
  const hits: RedactionHit[] = [];
  for (const p of patterns) {
    const m = compile(p).exec(text);
    if (m) hits.push({ pattern: p, sample: `${m[0].slice(0, 6)}...` });
  }
  return hits;
}
