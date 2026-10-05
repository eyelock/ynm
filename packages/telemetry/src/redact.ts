/** What a secret is replaced with in exported telemetry. */
export const REDACTED = "[REDACTED]";

/** Longest string value exported; the rest is cut, so no attribute can carry a document. */
export const MAX_STRING = 256;

/** Longest log record body exported. */
export const MAX_LINE = 1024;

/**
 * Compiles redaction patterns as the store does (a leading `(?i)` makes one case-insensitive),
 * global so every match is replaced. A pattern that does not compile is skipped: telemetry never
 * fails because of a bad setting.
 */
export function compilePatterns(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of new Set(patterns)) {
    const m = /^\(\?i\)(.*)$/.exec(p);
    try {
      out.push(m ? new RegExp(m[1] as string, "gi") : new RegExp(p, "g"));
    } catch {}
  }
  return out;
}

/** Replaces every match of every pattern, then caps the length. */
export function redactText(text: string, patterns: readonly RegExp[], max = MAX_STRING): string {
  let out = text;
  for (const re of patterns) out = out.replace(re, REDACTED);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/**
 * A stderr line as a log record body: quoted strings are masked as well as redacted, because an
 * error message can quote what it failed to parse, and a request body is content.
 */
export function logBody(line: string, patterns: readonly RegExp[]): string {
  return redactText(line.replace(/"(?:[^"\\]|\\.)*"/g, '"…"'), patterns, MAX_LINE);
}
